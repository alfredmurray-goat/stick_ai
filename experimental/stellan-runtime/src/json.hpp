#pragma once
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace stellan::json {
struct Value;
using Array = std::vector<Value>;
// Objects keep insertion order like JavaScript; a repeated key keeps its first position and its last value.
using Object = std::vector<std::pair<std::string, Value>>;
struct Null {};
struct Value {
    std::variant<Null, bool, double, std::string, std::shared_ptr<Array>, std::shared_ptr<Object>> data;
    bool is_null() const { return std::holds_alternative<Null>(data); }
    bool is_object() const { return std::holds_alternative<std::shared_ptr<Object>>(data); }
    bool is_array() const { return std::holds_alternative<std::shared_ptr<Array>>(data); }
    bool is_string() const { return std::holds_alternative<std::string>(data); }
    const Object &object() const { return *std::get<std::shared_ptr<Object>>(data); }
    const Array &array() const { return *std::get<std::shared_ptr<Array>>(data); }
    const std::string &string() const { return std::get<std::string>(data); }
    const Value *find(std::string_view key) const;
};
/** JSON.parse: throws std::runtime_error on invalid input (same acceptance as JavaScript, including depth limits). */
Value parse(std::string_view text);
/** JSON.stringify with no spacing: identical output to JavaScript for every value parse() can produce. */
std::string stringify(const Value &value);
std::string stringify_string(std::string_view utf8);
}
