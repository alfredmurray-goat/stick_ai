#include "https.hpp"
#include "json.hpp"

#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <functional>
#include <cctype>
#include <iostream>
#include <memory>
#include <stdexcept>

namespace stellan::https {
namespace {
std::string tls_error(const char *what, int code) {
    char text[200];
    mbedtls_strerror(code, text, sizeof text);
    return std::string(what) + ": " + text;
}
struct Url { std::string host, port, path; };
Url parse_url(const std::string &url) {
    // Only https, no userinfo, no fragment: the app never needs anything else, and refusing keeps tokens off plain HTTP.
    if (url.rfind("https://", 0) != 0) { throw std::runtime_error("Only https:// addresses are allowed"); }
    const auto rest = url.substr(8);
    const auto slash = rest.find('/');
    auto authority = rest.substr(0, slash);
    if (authority.empty() || authority.find('@') != std::string::npos || url.find('#') != std::string::npos) { throw std::runtime_error("Invalid address"); }
    Url out {authority, "443", slash == std::string::npos ? "/" : rest.substr(slash)};
    if (const auto colon = authority.rfind(':'); colon != std::string::npos && authority.find(']') == std::string::npos) {
        out.host = authority.substr(0, colon);
        out.port = authority.substr(colon + 1);
        if (out.port.empty() || !std::all_of(out.port.begin(), out.port.end(), [](unsigned char c) { return std::isdigit(c); })) { throw std::runtime_error("Invalid port"); }
    }
    for (const char c : out.path) { if (static_cast<unsigned char>(c) <= 0x20 || c == 0x7F) { throw std::runtime_error("Invalid address"); } }
    return out;
}
struct Tls {
    mbedtls_net_context net; mbedtls_ssl_context ssl; mbedtls_ssl_config conf; mbedtls_x509_crt ca; mbedtls_entropy_context entropy; mbedtls_ctr_drbg_context drbg;
    Tls() { mbedtls_net_init(&net); mbedtls_ssl_init(&ssl); mbedtls_ssl_config_init(&conf); mbedtls_x509_crt_init(&ca); mbedtls_entropy_init(&entropy); mbedtls_ctr_drbg_init(&drbg); }
    ~Tls() { mbedtls_ssl_close_notify(&ssl); mbedtls_net_free(&net); mbedtls_ssl_free(&ssl); mbedtls_ssl_config_free(&conf); mbedtls_x509_crt_free(&ca); mbedtls_ctr_drbg_free(&drbg); mbedtls_entropy_free(&entropy); }
    Tls(const Tls &) = delete; Tls &operator=(const Tls &) = delete;
};
std::string lower(std::string s) { for (auto &c : s) { c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); } return s; }
}

Response request(const Request &r, const std::function<void(const char *, std::size_t)> &sink) {
    const auto url = parse_url(r.url);
    for (const auto &[name, value] : r.headers) {
        for (const char c : name + value) { if (c == '\r' || c == '\n') { throw std::runtime_error("Invalid header"); } }
    }
    Tls tls;
    int code = 0;
    if ((code = mbedtls_ctr_drbg_seed(&tls.drbg, mbedtls_entropy_func, &tls.entropy, nullptr, 0)) != 0) { throw std::runtime_error(tls_error("Cannot start TLS", code)); }
    // Certificates are always checked against the bundled roots and the host name; there is no switch to skip it.
    if ((code = mbedtls_x509_crt_parse_file(&tls.ca, r.ca_file.c_str())) < 0) { throw std::runtime_error(tls_error("Cannot read the trusted certificates", code)); }
    if ((code = mbedtls_net_connect(&tls.net, url.host.c_str(), url.port.c_str(), MBEDTLS_NET_PROTO_TCP)) != 0) { throw std::runtime_error("Cannot reach " + url.host + ". Check the internet connection."); }
    if ((code = mbedtls_ssl_config_defaults(&tls.conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT)) != 0) { throw std::runtime_error(tls_error("Cannot set up TLS", code)); }
    mbedtls_ssl_conf_authmode(&tls.conf, MBEDTLS_SSL_VERIFY_REQUIRED);
    mbedtls_ssl_conf_ca_chain(&tls.conf, &tls.ca, nullptr);
    mbedtls_ssl_conf_rng(&tls.conf, mbedtls_ctr_drbg_random, &tls.drbg);
    mbedtls_ssl_conf_min_tls_version(&tls.conf, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_read_timeout(&tls.conf, static_cast<uint32_t>(r.timeout_ms));
    if ((code = mbedtls_ssl_setup(&tls.ssl, &tls.conf)) != 0 || (code = mbedtls_ssl_set_hostname(&tls.ssl, url.host.c_str())) != 0) { throw std::runtime_error(tls_error("Cannot set up TLS", code)); }
    mbedtls_ssl_set_bio(&tls.ssl, &tls.net, mbedtls_net_send, nullptr, mbedtls_net_recv_timeout);
    while ((code = mbedtls_ssl_handshake(&tls.ssl)) != 0) {
        if (code != MBEDTLS_ERR_SSL_WANT_READ && code != MBEDTLS_ERR_SSL_WANT_WRITE) {
            if (mbedtls_ssl_get_verify_result(&tls.ssl) != 0) { throw std::runtime_error("The certificate of " + url.host + " could not be verified. Check the computer's date and time."); }
            throw std::runtime_error(tls_error(("Secure connection to " + url.host + " failed").c_str(), code));
        }
    }
    std::string head = r.method + " " + url.path + " HTTP/1.1\r\nHost: " + url.host + (url.port == "443" ? "" : ":" + url.port) + "\r\nConnection: close\r\nUser-Agent: stick-ai\r\nAccept-Encoding: identity\r\n";
    for (const auto &[name, value] : r.headers) { head += name + ": " + value + "\r\n"; }
    if (!r.body.empty() || r.method == "POST" || r.method == "PUT") { head += "Content-Length: " + std::to_string(r.body.size()) + "\r\n"; }
    const auto out = head + "\r\n" + r.body;
    for (std::size_t sent = 0; sent < out.size();) {
        const int n = mbedtls_ssl_write(&tls.ssl, reinterpret_cast<const unsigned char *>(out.data() + sent), out.size() - sent);
        if (n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE) { continue; }
        if (n <= 0) { throw std::runtime_error(tls_error("Sending failed", n)); }
        sent += static_cast<std::size_t>(n);
    }
    // Headers first; the body then goes to `sink` as it arrives (chunked encoding decoded on the fly), so large
    // downloads never sit in memory.
    std::string raw, pending;
    Response response;
    bool have_headers = false, chunked = false, finished = false;
    std::size_t chunk_left = 0, total = 0;
    long long expected = -1;
    enum class Chunk { size, data, data_end, trailer } state = Chunk::size;
    const auto deliver = [&](const char *data, std::size_t size) {
        total += size;
        if (total > r.max_bytes) { throw std::runtime_error("The response from " + url.host + " is too large"); }
        if (size) { sink(data, size); }
    };
    const auto feed = [&](const std::string &bytes) {
        if (!chunked) { deliver(bytes.data(), bytes.size()); return; }
        pending += bytes;
        for (;;) {
            if (state == Chunk::size) {
                const auto line = pending.find("\r\n");
                if (line == std::string::npos) { if (pending.size() > 1024) { throw std::runtime_error("Invalid response from " + url.host); } return; }
                chunk_left = std::stoul(pending.substr(0, line), nullptr, 16);
                pending.erase(0, line + 2);
                state = chunk_left ? Chunk::data : Chunk::trailer;
            } else if (state == Chunk::data) {
                const auto take = std::min(chunk_left, pending.size());
                deliver(pending.data(), take);
                pending.erase(0, take);
                chunk_left -= take;
                if (chunk_left) { return; }
                state = Chunk::data_end;
            } else if (state == Chunk::data_end) {
                if (pending.size() < 2) { return; }
                pending.erase(0, 2);
                state = Chunk::size;
            } else { finished = true; pending.clear(); return; }
        }
    };
    unsigned char buffer[16384];
    for (;;) {
        const int n = mbedtls_ssl_read(&tls.ssl, buffer, sizeof buffer);
        if (n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE) { continue; }
        if (n == 0 || n == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) { break; }
        if (n == MBEDTLS_ERR_SSL_TIMEOUT) { throw std::runtime_error(url.host + " did not answer in time. Try again."); }
        if (n < 0) { throw std::runtime_error(tls_error("Receiving failed", n)); }
        const std::string bytes(reinterpret_cast<char *>(buffer), static_cast<std::size_t>(n));
        if (have_headers) { feed(bytes); if (finished) { break; } continue; }
        raw += bytes;
        const auto end = raw.find("\r\n\r\n");
        if (end == std::string::npos) { if (raw.size() > 65536) { throw std::runtime_error("Invalid response from " + url.host); } continue; }
        std::size_t at = raw.find("\r\n");
        const auto status_line = raw.substr(0, at);
        const auto space = status_line.find(' ');
        response.status = space == std::string::npos ? 0 : std::atoi(status_line.c_str() + space + 1);
        while (at < end) {
            const auto next = raw.find("\r\n", at + 2);
            const auto line = raw.substr(at + 2, next - at - 2);
            if (const auto colon = line.find(':'); colon != std::string::npos) {
                auto value = line.substr(colon + 1);
                while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) { value.erase(0, 1); }
                while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) { value.pop_back(); }
                response.headers.emplace_back(lower(line.substr(0, colon)), value);
            }
            at = next;
        }
        for (const auto &[k, v] : response.headers) {
            if (k == "transfer-encoding" && lower(v).find("chunked") != std::string::npos) { chunked = true; }
            if (k == "content-length") { expected = std::stoll(v); }
        }
        have_headers = true;
        const auto rest = raw.substr(end + 4);
        raw.clear();
        if (r.method == "HEAD" || response.status == 204 || response.status == 304) { break; }
        feed(rest);
        if (finished) { break; }
    }
    if (!have_headers) { throw std::runtime_error("Invalid response from " + url.host); }
    const bool bodyless = r.method == "HEAD" || response.status == 204 || response.status == 304;
    if (!bodyless && ((chunked && !finished) || (!chunked && expected >= 0 && static_cast<long long>(total) != expected))) {
        throw std::runtime_error("Truncated response from " + url.host);
    }
    return response;
}

// stellan-host --fetch CA_FILE: one {"method","url","headers":{},"body","maxBytes","timeoutMs","saveTo"} per stdin
// line. The body is written to saveTo (a new file) as it arrives; prints {"status","headers":{}} or {"error"}.
// Requests carry tokens, so nothing is logged.
int fetch_service(const std::string &ca_file) {
    std::string line;
    while (std::getline(std::cin, line)) {
        auto out = std::make_shared<json::Object>();
        try {
            const auto value = json::parse(line);
            Request r;
            r.ca_file = ca_file;
            r.method = value.find("method")->string();
            if (r.method != "GET" && r.method != "POST" && r.method != "PUT" && r.method != "DELETE" && r.method != "PATCH" && r.method != "HEAD") { throw std::runtime_error("Unsupported method"); }
            r.url = value.find("url")->string();
            if (const auto *h = value.find("headers")) { for (const auto &[k, v] : h->object()) { r.headers.emplace_back(k, v.string()); } }
            if (const auto *b = value.find("body"); b && b->is_string()) { r.body = b->string(); }
            if (const auto *m = value.find("maxBytes")) { r.max_bytes = static_cast<std::size_t>(std::get<double>(m->data)); }
            if (const auto *t = value.find("timeoutMs")) { r.timeout_ms = static_cast<int>(std::get<double>(t->data)); }
            const auto &target = value.find("saveTo")->string();
            const auto path = std::filesystem::path(std::u8string(reinterpret_cast<const char8_t *>(target.data()), target.size()));
            if (std::filesystem::exists(std::filesystem::symlink_status(path))) { throw std::runtime_error("The download file already exists"); }
            std::ofstream file(path, std::ios::binary);
            if (!file) { throw std::runtime_error("Cannot write the download file"); }
            const auto response = request(r, [&](const char *data, std::size_t size) { file.write(data, static_cast<std::streamsize>(size)); if (!file) { throw std::runtime_error("Cannot write the download file"); } });
            file.close();
            auto headers = std::make_shared<json::Object>();
            for (const auto &[k, v] : response.headers) { headers->emplace_back(k, json::Value {v}); }
            out->emplace_back("status", json::Value {static_cast<double>(response.status)});
            out->emplace_back("headers", json::Value {headers});
        } catch (const std::exception &error) {
            out->clear();
            out->emplace_back("error", json::Value {std::string(error.what())});
        }
        std::cout << json::stringify(json::Value {out}) << '\n';
        std::cout.flush();
    }
    return 0;
}
}
