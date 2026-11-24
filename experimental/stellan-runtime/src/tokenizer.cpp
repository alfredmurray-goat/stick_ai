#include "lite.hpp"

#include <algorithm>
#include <cmath>
#include <charconv>
#include <limits>
#include <queue>
#include <stdexcept>

namespace stellan {
Tokenizer::Tokenizer(const Model &model) : model_(model) {
    const auto &tokens = model.vocabulary();
    bpe_ = model.text("tokenizer.ggml.model") == "gpt2";
    if (tokens.empty() || (!bpe_ && tokens.size() != model.scores().size()) || tokens.size() != model.token_types().size()) {
        throw std::runtime_error("A complete SentencePiece vocabulary is required");
    }
    if (bpe_) {
        if (model.text("tokenizer.ggml.pre") != "tekken" || model.merges().empty()) { throw std::runtime_error("Only the audited Tekken BPE configuration is supported"); }
        unsigned extra = 0;
        for (unsigned byte = 0; byte < 256; ++byte) {
            const auto code = (byte >= 33 && byte <= 126) || (byte >= 161 && byte <= 172) || byte >= 174 ? byte : 256 + extra++;
            std::string encoded;
            if (code < 128) { encoded += static_cast<char>(code); }
            else { encoded += static_cast<char>(0xc0 | (code >> 6)); encoded += static_cast<char>(0x80 | (code & 63)); }
            byte_characters_[encoded] = byte;
        }
    }
    bos_ = static_cast<std::int32_t>(model.number("tokenizer.ggml.bos_token_id"));
    eos_ = static_cast<std::int32_t>(model.number("tokenizer.ggml.eos_token_id"));
    if (bos_ < 0 || eos_ < 0 || static_cast<std::size_t>(std::max(bos_, eos_)) >= tokens.size()) {
        throw std::runtime_error("Invalid tokenizer boundary tokens");
    }
    for (std::size_t i = 0; i < tokens.size(); ++i) {
        if (!lookup_.emplace(tokens[i], static_cast<std::int32_t>(i)).second) {
            throw std::runtime_error("Duplicate vocabulary entry");
        }
        if (model.token_types()[i] == 3 || model.token_types()[i] == 4) specials_.emplace_back(tokens[i], static_cast<std::int32_t>(i));
        if (model.token_types()[i] == 6) {
            unsigned byte = 0;
            const auto parsed = tokens[i].size() == 6 ? std::from_chars(tokens[i].data() + 3, tokens[i].data() + 5, byte, 16) : std::from_chars_result {};
            if (tokens[i].size() != 6 || tokens[i].substr(0, 3) != "<0x" || tokens[i][5] != '>' || parsed.ec != std::errc() || parsed.ptr != tokens[i].data() + 5 || byte > 255) {
                throw std::runtime_error("Invalid byte fallback token");
            }
            bytes_[byte] = static_cast<std::int32_t>(i);
        }
    }
    std::stable_sort(specials_.begin(), specials_.end(), [](const auto &a, const auto &b) { return a.first.size() > b.first.size(); });
    if (model.text("tokenizer.ggml.model") == "llama" && bytes_.size() != 256) { throw std::runtime_error("All byte fallback tokens are required"); }
}

void Tokenizer::ordinary(const std::string &text, std::vector<std::int32_t> &output, bool prefix) const {
    if (text.empty()) { return; }
    std::string normalized = prefix ? "▁" : "";
    for (const auto c : text) {
        if (c == ' ') { normalized += "▁"; } else { normalized += c; }
    }
    struct Node { std::string text; std::size_t previous; std::size_t next; unsigned version = 0; bool alive = true; };
    struct Pair { float score; std::size_t left; std::size_t right; unsigned left_version; unsigned right_version; };
    struct Earlier {
        bool operator()(const Pair &a, const Pair &b) const {
            return a.score == b.score ? a.left > b.left : a.score < b.score;
        }
    };
    const auto end = std::numeric_limits<std::size_t>::max();
    std::vector<Node> nodes;
    for (std::size_t i = 0; i < normalized.size();) {
        const auto c = static_cast<unsigned char>(normalized[i]);
        const auto length = c < 0x80 ? 1U : (c & 0xe0) == 0xc0 ? 2U : (c & 0xf0) == 0xe0 ? 3U : (c & 0xf8) == 0xf0 ? 4U : 1U;
        const auto n = std::min<std::size_t>(length, normalized.size() - i);
        const auto index = nodes.size();
        nodes.push_back({normalized.substr(i, n), index == 0 ? end : index - 1, index + 1});
        i += n;
    }
    nodes.back().next = end;
    std::priority_queue<Pair, std::vector<Pair>, Earlier> pairs;
    const auto enqueue = [&](std::size_t left) {
        if (left == end || !nodes[left].alive || nodes[left].next == end) { return; }
        const auto right = nodes[left].next;
        const auto found = lookup_.find(nodes[left].text + nodes[right].text);
        if (found == lookup_.end() || model_.token_types()[static_cast<std::size_t>(found->second)] != 1) { return; }
        const auto score = model_.scores()[static_cast<std::size_t>(found->second)];
        if (!std::isfinite(score)) { throw std::runtime_error("Non-finite vocabulary score"); }
        pairs.push({score, left, right, nodes[left].version, nodes[right].version});
    };
    for (std::size_t i = 0; i < nodes.size(); ++i) { enqueue(i); }
    while (!pairs.empty()) {
        const auto pair = pairs.top();
        pairs.pop();
        auto &left = nodes[pair.left];
        auto &right = nodes[pair.right];
        if (!left.alive || !right.alive || left.next != pair.right || left.version != pair.left_version || right.version != pair.right_version) { continue; }
        left.text += right.text;
        left.next = right.next;
        ++left.version;
        right.alive = false;
        if (right.next != end) { nodes[right.next].previous = pair.left; }
        enqueue(left.previous);
        enqueue(pair.left);
    }
    for (std::size_t i = 0; i != end; i = nodes[i].next) {
        const auto found = lookup_.find(nodes[i].text);
        if (found != lookup_.end() && model_.token_types()[static_cast<std::size_t>(found->second)] == 1) {
            output.push_back(found->second);
        } else {
            for (const unsigned char byte : nodes[i].text) { output.push_back(bytes_.at(byte)); }
        }
    }
}

std::vector<std::int32_t> Tokenizer::encode(const std::string &text, std::size_t token_limit) const {
    if (bpe_) { throw std::runtime_error("Tekken text uses the Node tokenizer bridge; native decode accepts token IDs"); }
    if (text.size() > 1048576) { throw std::runtime_error("Prompt exceeds prototype limit"); }
    std::vector<std::int32_t> result {bos_};
    std::string ordinary_text;
    bool prefix = true;
    for (std::size_t i = 0; i < text.size();) {
        std::int32_t special = -1;
        std::size_t length = 0;
        if (text[i] == '<' || text[i] == '[') {
            for (const auto &[piece, token] : specials_) {
                if (text.compare(i, piece.size(), piece) == 0) {
                    special = token; length = piece.size(); break;
                }
            }
        }
        if (special >= 0) {
            ordinary(ordinary_text, result, prefix);
            ordinary_text.clear();
            if (!(special == bos_ && i == 0 && result.size() == 1)) { result.push_back(special); }
            i += length;
            prefix = false;
        } else {
            ordinary_text += text[i++];
        }
    }
    ordinary(ordinary_text, result, prefix);
    if (token_limit == 0 || token_limit > 262144 || result.size() > token_limit) { throw std::runtime_error("Prompt token count exceeds configured limit"); }
    return result;
}

std::string Tokenizer::decode(std::int32_t token) const {
    if (token < 0 || static_cast<std::size_t>(token) >= model_.vocabulary().size()) { throw std::runtime_error("Invalid token ID"); }
    const auto id = static_cast<std::size_t>(token);
    const auto &piece = model_.vocabulary()[id];
    if (bpe_ && model_.token_types()[id] == 1) {
        std::string decoded;
        for (std::size_t i = 0; i < piece.size();) {
            const auto length = static_cast<unsigned char>(piece[i]) < 128 ? 1U : 2U;
            const auto found = byte_characters_.find(piece.substr(i, length));
            if (found == byte_characters_.end()) { throw std::runtime_error("Invalid byte-encoded token"); }
            decoded += static_cast<char>(found->second);
            i += length;
        }
        return decoded;
    }
    if (model_.token_types()[id] == 6) {
        unsigned byte = 0;
        std::from_chars(piece.data() + 3, piece.data() + 5, byte, 16);
        return std::string(1, static_cast<char>(byte));
    }
    if (model_.token_types()[id] == 3) { return ""; }
    std::string output;
    for (std::size_t i = 0; i < piece.size();) {
        if (piece.compare(i, 3, "▁") == 0) { output += ' '; i += 3; } else { output += piece[i++]; }
    }
    return output;
}
std::int32_t Tokenizer::eos() const { return eos_; }
}
