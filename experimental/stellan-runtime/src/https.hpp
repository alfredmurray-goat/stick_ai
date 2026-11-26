#pragma once
#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace stellan::https {
struct Request {
    std::string method = "GET", url, body, ca_file;
    std::vector<std::pair<std::string, std::string>> headers;
    std::size_t max_bytes = 1024 * 1024;
    int timeout_ms = 30000; // 0: wait as long as the server keeps the connection open (event streams)
};
struct Response { int status = 0; std::vector<std::pair<std::string, std::string>> headers; };
/** One HTTPS request with certificate and host-name checks against the bundled roots; redirects are not followed. */
Response request(const Request &request, const std::function<void(const char *, std::size_t)> &sink, const std::function<void(const Response &)> &on_headers = {});
int fetch_service(const std::string &ca_file);
}
