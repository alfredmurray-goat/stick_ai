#include "crypto.hpp"
#include "json.hpp"

#include <mbedtls/gcm.h>
#include <mbedtls/hkdf.h>
#include <mbedtls/md.h>
#include <monocypher-ed25519.h>

#include <iostream>
#include <memory>
#include <stdexcept>

namespace stellan::crypto {
namespace {
int value_of(char c, bool url) {
    if (c >= 'A' && c <= 'Z') { return c - 'A'; }
    if (c >= 'a' && c <= 'z') { return c - 'a' + 26; }
    if (c >= '0' && c <= '9') { return c - '0' + 52; }
    if (c == (url ? '-' : '+')) { return 62; }
    if (c == (url ? '_' : '/')) { return 63; }
    return -1;
}
}
// Node's Buffer.from(text, "base64" | "base64url") is lenient: it skips characters outside the alphabet and stops at
// '='. The keys and signatures here are checked for exact lengths afterwards, so leniency never widens acceptance.
std::string base64_decode(std::string_view text, bool url) {
    std::string out;
    unsigned buffer = 0; int bits = 0;
    for (const char c : text) {
        if (c == '=') { break; }
        int v = value_of(c, url);
        if (v < 0) { v = value_of(c, !url); }
        if (v < 0) { continue; }
        buffer = (buffer << 6) | static_cast<unsigned>(v); bits += 6;
        if (bits >= 8) { bits -= 8; out += static_cast<char>((buffer >> bits) & 0xFF); }
    }
    return out;
}
std::string base64_encode(std::string_view bytes) {
    static const char chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out; std::size_t i = 0;
    for (; i + 2 < bytes.size(); i += 3) {
        const unsigned v = (static_cast<unsigned char>(bytes[i]) << 16) | (static_cast<unsigned char>(bytes[i + 1]) << 8) | static_cast<unsigned char>(bytes[i + 2]);
        out += chars[v >> 18]; out += chars[(v >> 12) & 63]; out += chars[(v >> 6) & 63]; out += chars[v & 63];
    }
    if (i < bytes.size()) {
        unsigned v = static_cast<unsigned char>(bytes[i]) << 16;
        if (i + 1 < bytes.size()) { v |= static_cast<unsigned char>(bytes[i + 1]) << 8; }
        out += chars[v >> 18]; out += chars[(v >> 12) & 63]; out += i + 1 < bytes.size() ? chars[(v >> 6) & 63] : '='; out += '=';
    }
    return out;
}
std::string ed25519_public_key(std::string_view text) {
    std::string body(text);
    if (body.find("-----BEGIN PUBLIC KEY-----") != std::string::npos) {
        const auto start = body.find('\n', body.find("-----BEGIN PUBLIC KEY-----"));
        const auto end = body.find("-----END PUBLIC KEY-----");
        if (start == std::string::npos || end == std::string::npos || end < start) { return {}; }
        body = body.substr(start + 1, end - start - 1);
    }
    const auto der = base64_decode(body, false);
    static const unsigned char prefix[] = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
    if (der.size() != sizeof prefix + 32 || der.compare(0, sizeof prefix, reinterpret_cast<const char *>(prefix), sizeof prefix) != 0) { return {}; }
    return der.substr(sizeof prefix);
}
bool ed25519_verify(std::string_view raw_key, std::string_view message, std::string_view signature) {
    if (raw_key.size() != 32 || signature.size() != 64) { return false; }
    return crypto_ed25519_check(reinterpret_cast<const std::uint8_t *>(signature.data()), reinterpret_cast<const std::uint8_t *>(raw_key.data()),
                                reinterpret_cast<const std::uint8_t *>(message.data()), message.size()) == 0;
}
std::optional<std::string> unwrap_model_key(std::string_view wrapped_base64, std::string_view stick_hex, std::string_view code) {
    const auto sealed = base64_decode(wrapped_base64, false);
    if (sealed.size() != 12 + 32 + 16 || stick_hex.size() % 2 != 0) { return std::nullopt; }
    std::string stick;
    for (std::size_t i = 0; i + 1 < stick_hex.size(); i += 2) {
        const auto hex = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
        const int a = hex(stick_hex[i]), b = hex(stick_hex[i + 1]);
        if (a < 0 || b < 0) { break; } // Buffer.from(hex) stops at the first invalid pair
        stick += static_cast<char>(a * 16 + b);
    }
    unsigned char wrapping[32];
    // hkdfSync("sha256", ikm = stick, salt = "stick-ai-model-keys", info = code, 32)
    if (mbedtls_hkdf(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), reinterpret_cast<const unsigned char *>("stick-ai-model-keys"), 19,
                     reinterpret_cast<const unsigned char *>(stick.data()), stick.size(), reinterpret_cast<const unsigned char *>(code.data()), code.size(), wrapping, sizeof wrapping) != 0) { return std::nullopt; }
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    std::string key(32, '\0');
    const auto *s = reinterpret_cast<const unsigned char *>(sealed.data());
    const bool ok = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, wrapping, 256) == 0 &&
                    mbedtls_gcm_auth_decrypt(&gcm, 32, s, 12, nullptr, 0, s + 44, 16, s + 12, reinterpret_cast<unsigned char *>(key.data())) == 0;
    mbedtls_gcm_free(&gcm);
    if (!ok) { return std::nullopt; }
    return key;
}

// stellan-host --crypto: one request per line.
//   {"op":"verify","key":<SPKI base64 or PEM>,"message":<base64>,"signature":<base64>} -> {"ok":bool}
//   {"op":"unwrap","wrapped":<base64>,"stick":<hex>,"code":<text>} -> {"key":<base64>} or {"key":null}
int crypto_service() {
    std::string line;
    while (std::getline(std::cin, line)) {
        auto out = std::make_shared<json::Object>();
        try {
            const auto request = json::parse(line);
            const auto &op = request.find("op")->string();
            if (op == "verify") {
                const auto key = ed25519_public_key(request.find("key")->string());
                out->emplace_back("ok", json::Value {!key.empty() && ed25519_verify(key, base64_decode(request.find("message")->string(), false), base64_decode(request.find("signature")->string(), true))});
            } else if (op == "unwrap") {
                const auto key = unwrap_model_key(request.find("wrapped")->string(), request.find("stick")->string(), request.find("code")->string());
                out->emplace_back("key", key ? json::Value {base64_encode(*key)} : json::Value {});
            } else { throw std::runtime_error("Unknown operation"); }
        } catch (const std::exception &error) { out->clear(); out->emplace_back("error", json::Value {std::string(error.what())}); }
        std::cout << json::stringify(json::Value {out}) << '\n';
        std::cout.flush();
    }
    return 0;
}
}
