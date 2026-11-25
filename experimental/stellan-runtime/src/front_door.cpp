#include "front_door.hpp"

#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
constexpr socket_t invalid_socket = INVALID_SOCKET;
void close_socket(socket_t s) { closesocket(s); }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
constexpr socket_t invalid_socket = -1;
void close_socket(socket_t s) { close(s); }
#endif

namespace stellan {
namespace {
// Same limits as the Node server: headers within 10 s, at most 64 KiB of headers, request bodies up to 64 MiB
// (attachments), and the same security headers on everything the front door answers itself.
constexpr std::size_t header_limit = 64 * 1024;
constexpr std::size_t body_limit = 64 * 1024 * 1024;
constexpr const char *security_headers =
    "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n"
    "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n";

struct Asset { const char *file; const char *type; };
const std::map<std::string, Asset, std::less<>> assets {
    {"/", {"index.html", "text/html"}}, {"/main.js", {"main.js", "text/javascript"}}, {"/highlight.js", {"highlight.js", "text/javascript"}},
    {"/style.css", {"style.css", "text/css"}}, {"/brand/icon-dark.png", {"brand/icon-dark.png", "image/png"}},
    {"/brand/icon-light.png", {"brand/icon-light.png", "image/png"}}, {"/brand/favicon.png", {"brand/favicon.png", "image/png"}},
};

bool send_all(socket_t s, const char *data, std::size_t size) {
    while (size > 0) {
        const auto sent = ::send(s, data, static_cast<int>(std::min<std::size_t>(size, 1 << 20)), 0);
        if (sent <= 0) { return false; }
        data += sent; size -= static_cast<std::size_t>(sent);
    }
    return true;
}
bool send_all(socket_t s, std::string_view text) { return send_all(s, text.data(), text.size()); }

void set_timeout(socket_t s, int seconds) {
#ifdef _WIN32
    DWORD ms = static_cast<DWORD>(seconds * 1000);
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&ms), sizeof ms);
#else
    timeval tv {seconds, 0};
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
#endif
}

void reply(socket_t s, int code, std::string_view reason, std::string_view type, std::string_view body) {
    std::ostringstream head;
    head << "HTTP/1.1 " << code << ' ' << reason << "\r\n" << security_headers << "Content-Type: " << type << "\r\nContent-Length: " << body.size() << "\r\nConnection: close\r\n\r\n";
    if (send_all(s, head.str())) { send_all(s, body); }
}

std::string lower(std::string_view text) {
    std::string result(text);
    for (auto &c : result) { c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); }
    return result;
}

struct Request {
    std::string method, target, version;
    std::vector<std::pair<std::string, std::string>> headers; // original names, in order
    std::string body;
    std::optional<std::string> header(std::string_view name) const {
        for (const auto &[key, value] : headers) { if (lower(key) == name) { return value; } }
        return std::nullopt;
    }
};

// Reads one request: start line, headers and a Content-Length body. Chunked request bodies are refused (browsers
// send Content-Length for fetch bodies), which keeps the parser small.
std::optional<Request> read_request(socket_t s, int &status) {
    std::string data;
    std::array<char, 16384> buffer {};
    std::size_t end = std::string::npos;
    while ((end = data.find("\r\n\r\n")) == std::string::npos) {
        if (data.size() > header_limit) { status = 431; return std::nullopt; }
        const auto got = recv(s, buffer.data(), static_cast<int>(buffer.size()), 0);
        if (got <= 0) { status = 0; return std::nullopt; }
        data.append(buffer.data(), static_cast<std::size_t>(got));
    }
    Request request;
    std::istringstream lines(data.substr(0, end));
    std::string line;
    if (!std::getline(lines, line)) { status = 400; return std::nullopt; }
    if (!line.empty() && line.back() == '\r') { line.pop_back(); }
    std::istringstream start(line);
    if (!(start >> request.method >> request.target >> request.version) || request.target.empty() || request.target[0] != '/' || request.version.rfind("HTTP/1.", 0) != 0) { status = 400; return std::nullopt; }
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') { line.pop_back(); }
        const auto colon = line.find(':');
        if (colon == std::string::npos || colon == 0) { status = 400; return std::nullopt; }
        auto value = line.substr(colon + 1);
        while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) { value.erase(0, 1); }
        while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) { value.pop_back(); }
        request.headers.emplace_back(line.substr(0, colon), value);
    }
    if (request.header("transfer-encoding")) { status = 411; return std::nullopt; }
    std::size_t length = 0;
    if (const auto value = request.header("content-length")) {
        if (value->empty() || value->size() > 12 || value->find_first_not_of("0123456789") != std::string::npos) { status = 400; return std::nullopt; }
        length = std::stoull(*value);
        if (length > body_limit) { status = 413; return std::nullopt; }
    }
    request.body = data.substr(end + 4);
    while (request.body.size() < length) {
        const auto got = recv(s, buffer.data(), static_cast<int>(std::min<std::size_t>(buffer.size(), length - request.body.size())), 0);
        if (got <= 0) { status = 0; return std::nullopt; }
        request.body.append(buffer.data(), static_cast<std::size_t>(got));
    }
    if (request.body.size() > length) { request.body.resize(length); }
    return request;
}

socket_t connect_local(int port) {
    const socket_t s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == invalid_socket) { return s; }
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(s, reinterpret_cast<sockaddr *>(&address), sizeof address) != 0) { close_socket(s); return invalid_socket; }
    return s;
}

struct Settings { std::filesystem::path ui; int backend_port; std::string origin, backend_origin; };

void handle(socket_t client, const Settings &settings) {
    set_timeout(client, 10);
    int status = 400;
    auto request = read_request(client, status);
    if (!request) {
        if (status) { reply(client, status, "Bad Request", "application/json", "{}"); }
        close_socket(client); return;
    }
    // Only this front door's own address is accepted, exactly as the Node server checks its Host header.
    if (request->header("host").value_or("") != settings.origin.substr(7)) { reply(client, 403, "Forbidden", "application/json", "{}"); close_socket(client); return; }
    const auto path = std::string_view(request->target).substr(0, request->target.find('?'));
    if (request->method == "GET") {
        if (const auto asset = assets.find(path); asset != assets.end()) {
            std::ifstream file(settings.ui / asset->second.file, std::ios::binary);
            std::ostringstream content;
            content << file.rdbuf();
            if (!file) { reply(client, 404, "Not Found", "application/json", "{}"); }
            else { reply(client, 200, "OK", asset->second.type, content.str()); }
            close_socket(client); return;
        }
    }
    // Everything else goes to the app backend while it still runs in Node. Authorization passes through untouched
    // (the backend checks the session key); Host and Origin are rewritten to the backend's own address so its
    // checks see a same-origin request, and only after this front door has checked them itself.
    if (const auto origin = request->header("origin"); origin && *origin != settings.origin) { reply(client, 403, "Forbidden", "application/json", "{}"); close_socket(client); return; }
    const socket_t backend = connect_local(settings.backend_port);
    if (backend == invalid_socket) { reply(client, 502, "Bad Gateway", "application/json", "{\"error\":\"The app is restarting. Try again in a moment.\"}"); close_socket(client); return; }
    std::ostringstream forward;
    forward << request->method << ' ' << request->target << " HTTP/1.1\r\n";
    for (const auto &[name, value] : request->headers) {
        const auto key = lower(name);
        if (key == "host" || key == "origin" || key == "connection" || key == "keep-alive" || key == "proxy-connection" || key == "upgrade") { continue; }
        forward << name << ": " << value << "\r\n";
    }
    forward << "Host: " << settings.backend_origin.substr(7) << "\r\n";
    if (request->header("origin")) { forward << "Origin: " << settings.backend_origin << "\r\n"; }
    forward << "Connection: close\r\n\r\n";
    if (send_all(backend, forward.str()) && send_all(backend, request->body)) {
        // Stream the reply back as it arrives (long-polls and streamed text), until the backend closes.
        std::array<char, 16384> buffer {};
        for (;;) {
            const auto got = recv(backend, buffer.data(), static_cast<int>(buffer.size()), 0);
            if (got <= 0 || !send_all(client, buffer.data(), static_cast<std::size_t>(got))) { break; }
        }
    }
    close_socket(backend);
    close_socket(client);
}
}

// stellan-host --front-door UI_FOLDER BACKEND_PORT
// Serves the app window on 127.0.0.1 (a free port, reported on stdout as a JSON line) and forwards every API request
// to the Node backend until each route has a native implementation. Stops when stdin closes (the owner went away).
int front_door(int argc, char **argv) {
    if (argc != 4) { throw std::runtime_error("Usage: stellan-host --front-door UI_FOLDER BACKEND_PORT"); }
#ifdef _WIN32
    WSADATA wsa {};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { throw std::runtime_error("Cannot start networking"); }
#endif
    const std::string port_text(argv[3]);
    if (port_text.empty() || port_text.size() > 5 || port_text.find_first_not_of("0123456789") != std::string::npos) { throw std::runtime_error("Invalid backend port"); }
    const int backend_port = std::stoi(port_text);
    if (backend_port < 1024 || backend_port > 65535) { throw std::runtime_error("Invalid backend port"); }
    const std::string ui_text(argv[2]);
    const std::filesystem::path ui(std::u8string(reinterpret_cast<const char8_t *>(ui_text.data()), ui_text.size()));
    if (!std::filesystem::is_regular_file(ui / "index.html")) { throw std::runtime_error("The app window files are missing"); }
    const socket_t listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == invalid_socket) { throw std::runtime_error("Cannot open the app window port"); }
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = 0;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // never reachable from other computers
    socklen_t size = sizeof address;
    if (bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof address) != 0 || listen(listener, 64) != 0 ||
        getsockname(listener, reinterpret_cast<sockaddr *>(&address), &size) != 0) { throw std::runtime_error("Cannot open the app window port"); }
    const int port = ntohs(address.sin_port);
    const Settings settings {ui, backend_port, "http://127.0.0.1:" + std::to_string(port), "http://127.0.0.1:" + std::to_string(backend_port)};
    std::cout << "{\"event\":\"ready\",\"port\":" << port << ",\"node_required\":true}" << std::endl;
    // The owner keeps stdin open; when it closes, stop accepting and exit.
    std::thread([listener] {
        std::array<char, 256> sink {};
        while (std::cin.read(sink.data(), sink.size()) || std::cin.gcount() > 0) {}
        close_socket(listener);
#ifdef _WIN32
        ExitProcess(0);
#else
        _exit(0);
#endif
    }).detach();
    for (;;) {
        const socket_t client = accept(listener, nullptr, nullptr);
        if (client == invalid_socket) { continue; }
        std::thread([client, &settings] { handle(client, settings); }).detach();
    }
}
}
