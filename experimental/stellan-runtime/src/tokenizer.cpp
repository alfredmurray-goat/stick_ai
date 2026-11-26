#include "lite.hpp"
#include "unicode_classes.hpp"

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
            byte_strings_[byte] = encoded;
        }
    }
    if (bpe_) {
        const auto &merges = model.merges();
        for (std::size_t i = 0; i < merges.size(); ++i) { ranks_.emplace(merges[i], static_cast<std::int32_t>(i)); }
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

namespace {
// Lowest-rank-first pair merging shared by SentencePiece (rank = -score) and Tekken BPE (rank = merge index); ties go
// to the leftmost pair, exactly as mergePieces in tokenizer.mjs.
template <typename Rank>
std::vector<std::string> merge_pieces(std::vector<std::string> pieces, Rank rank) {
    const auto end = std::numeric_limits<std::size_t>::max();
    struct Node { std::string text; std::size_t previous; std::size_t next; unsigned version = 0; bool alive = true; };
    struct Pair { double rank; std::size_t left; std::size_t right; unsigned left_version; unsigned right_version; };
    struct Later { bool operator()(const Pair &a, const Pair &b) const { return a.rank == b.rank ? a.left > b.left : a.rank > b.rank; } };
    if (pieces.empty()) { return {}; }
    std::vector<Node> nodes;
    nodes.reserve(pieces.size());
    for (std::size_t i = 0; i < pieces.size(); ++i) { nodes.push_back({std::move(pieces[i]), i == 0 ? end : i - 1, i + 1}); }
    nodes.back().next = end;
    std::priority_queue<Pair, std::vector<Pair>, Later> pairs;
    const auto enqueue = [&](std::size_t left) {
        if (left == end || !nodes[left].alive || nodes[left].next == end) { return; }
        const auto right = nodes[left].next;
        double value = 0;
        if (rank(nodes[left].text, nodes[right].text, value)) { pairs.push({value, left, right, nodes[left].version, nodes[right].version}); }
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
    std::vector<std::string> result;
    for (std::size_t i = 0; i != end; i = nodes[i].next) { result.push_back(std::move(nodes[i].text)); }
    return result;
}

std::uint8_t classes(std::uint32_t c) {
    const auto *first = std::begin(stellan::unicode::ranges);
    const auto *last = std::end(stellan::unicode::ranges);
    const auto *found = std::upper_bound(first, last, c, [](std::uint32_t value, const auto &range) { return value < range.first; });
    if (found == first) { return 0; }
    --found;
    return c <= found->last ? found->mask : 0;
}

// UTF-8 to code points the way a JavaScript string sees the text: each invalid sequence becomes U+FFFD.
std::vector<std::uint32_t> code_points(const std::string &text) {
    std::vector<std::uint32_t> result;
    for (std::size_t i = 0; i < text.size();) {
        const auto b = static_cast<unsigned char>(text[i]);
        std::size_t n = b < 0x80 ? 1 : b >= 0xc2 && b < 0xe0 ? 2 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xf0 && b < 0xf5 ? 4 : 0;
        std::uint32_t c = n == 1 ? b : n == 2 ? b & 0x1f : n == 3 ? b & 0x0f : b & 0x07;
        bool ok = n > 0 && i + n <= text.size();
        for (std::size_t k = 1; ok && k < n; ++k) {
            const auto t = static_cast<unsigned char>(text[i + k]);
            if ((t & 0xc0) != 0x80) { ok = false; break; }
            c = (c << 6) | (t & 0x3f);
        }
        if (ok && ((n == 3 && (c < 0x800 || (c >= 0xd800 && c <= 0xdfff))) || (n == 4 && (c < 0x10000 || c > 0x10ffff)))) { ok = false; }
        if (!ok) { result.push_back(0xfffd); ++i; continue; }
        result.push_back(c);
        i += n;
    }
    return result;
}

void append_utf8(std::string &out, std::uint32_t c) {
    if (c < 0x80) { out += static_cast<char>(c); }
    else if (c < 0x800) { out += static_cast<char>(0xc0 | (c >> 6)); out += static_cast<char>(0x80 | (c & 63)); }
    else if (c < 0x10000) { out += static_cast<char>(0xe0 | (c >> 12)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
    else { out += static_cast<char>(0xf0 | (c >> 18)); out += static_cast<char>(0x80 | ((c >> 12) & 63)); out += static_cast<char>(0x80 | ((c >> 6) & 63)); out += static_cast<char>(0x80 | (c & 63)); }
}

// One match of the Tekken pre-tokenizer regex from tokenizer.mjs, starting at `at`, following JavaScript's
// first-alternative, greedy-with-backtracking order. Returns the end of the match.
std::size_t tekken_match(const std::vector<std::uint32_t> &t, std::size_t at) {
    constexpr std::uint8_t L = 1, N = 2, A = 4, B = 8, S = 16;
    const auto n = t.size();
    const auto has = [&](std::size_t i, std::uint8_t bit) { return i < n && (classes(t[i]) & bit); };
    const auto line = [&](std::size_t i) { return i < n && (t[i] == '\r' || t[i] == '\n'); };
    const auto prefix = [&](std::size_t i) { return i < n && !line(i) && !has(i, L) && !has(i, N); };
    // 1: [^\r\n\p{L}\p{N}]? A* B+
    for (int skip = prefix(at) ? 1 : 0; skip >= 0; --skip) {
        const auto p = at + static_cast<std::size_t>(skip);
        auto k = p;
        while (has(k, A)) { ++k; }
        for (auto j = k + 1; j-- > p;) {
            if (has(j, B)) { auto e = j; while (has(e, B)) { ++e; } return e; }
        }
    }
    // 2: [^\r\n\p{L}\p{N}]? A+ B*
    for (int skip = prefix(at) ? 1 : 0; skip >= 0; --skip) {
        auto k = at + static_cast<std::size_t>(skip);
        if (!has(k, A)) { continue; }
        while (has(k, A)) { ++k; }
        while (has(k, B)) { ++k; }
        return k;
    }
    // 3: \p{N}
    if (has(at, N)) { return at + 1; }
    // 4: ' '? [^\s\p{L}\p{N}]+ [\r\n/]*
    const auto other = [&](std::size_t i) { return i < n && !has(i, S) && !has(i, L) && !has(i, N); };
    for (int skip = at < n && t[at] == ' ' ? 1 : 0; skip >= 0; --skip) {
        auto k = at + static_cast<std::size_t>(skip);
        if (!other(k)) { continue; }
        while (other(k)) { ++k; }
        while (line(k) || (k < n && t[k] == '/')) { ++k; }
        return k;
    }
    auto run = at;
    while (has(run, S)) { ++run; }
    if (run == at) { throw std::runtime_error("Tokenizer did not consume the prompt"); }
    // 5: \s* [\r\n]+  (the match ends after the last line break inside the space run)
    for (auto j = run; j-- > at;) { if (line(j)) { return j + 1; } }
    // 6: \s+(?!\S)  then  7: \s+
    if (run == n || run - at == 1) { return run; }
    return run - 1;
}
}

void Tokenizer::tekken(const std::string &text, std::vector<std::int32_t> &output) const {
    const auto points = code_points(text);
    for (std::size_t at = 0; at < points.size();) {
        const auto end = tekken_match(points, at);
        std::string piece;
        for (auto i = at; i < end; ++i) { append_utf8(piece, points[i]); }
        std::vector<std::string> bytes;
        for (const unsigned char byte : piece) { bytes.push_back(byte_strings_[byte]); }
        for (const auto &merged : merge_pieces(std::move(bytes), [&](const std::string &a, const std::string &b, double &rank) {
                 const auto found = ranks_.find(a + " " + b);
                 if (found == ranks_.end()) { return false; }
                 rank = found->second;
                 return true;
             })) {
            const auto id = lookup_.find(merged);
            if (id == lookup_.end() || model_.token_types()[static_cast<std::size_t>(id->second)] != 1) { throw std::runtime_error("BPE piece is missing from the vocabulary"); }
            output.push_back(id->second);
        }
        at = end;
    }
}

void Tokenizer::ordinary(const std::string &text, std::vector<std::int32_t> &output, bool prefix) const {
    if (text.empty()) { return; }
    if (bpe_) { tekken(text, output); return; }
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
    if (text.size() > 1048576) { throw std::runtime_error("Prompt exceeds prototype limit"); }
    std::vector<std::int32_t> result {bos_};
    std::string ordinary_text;
    bool prefix = true;
    for (std::size_t i = 0; i < text.size();) {
        std::int32_t special = -1;
        std::size_t length = 0;
        if (bpe_ || text[i] == '<' || text[i] == '[') {
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
