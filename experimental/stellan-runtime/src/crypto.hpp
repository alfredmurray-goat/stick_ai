#pragma once
#include <optional>
#include <string>
#include <string_view>

namespace stellan::crypto {
std::string base64_decode(std::string_view text, bool url);
std::string base64_encode(std::string_view bytes);
/** Raw 32-byte Ed25519 key from base64 SPKI DER or a PEM "PUBLIC KEY" block; empty if it is not one. */
std::string ed25519_public_key(std::string_view text);
/** RFC 8032 Ed25519 (pure) verification, as Node's crypto.verify(null, ...). */
bool ed25519_verify(std::string_view raw_key, std::string_view message, std::string_view signature);
/** activation.ts unwrapModelKey: HKDF-SHA256 then AES-256-GCM; nullopt when it does not open. */
std::optional<std::string> unwrap_model_key(std::string_view wrapped_base64, std::string_view stick_hex, std::string_view code);
int crypto_service();
}
