#include "provider/anthropic_adapter.hpp"
#include "provider/http_utils.hpp"
#include <curl/curl.h>
#include <stdexcept>
#include <sstream>
#include <string>

namespace zcode::provider {

using detail::writeCallback;
using detail::jsonEscape;

/**
 * Extract the first text block from an Anthropic Messages API response body
 * using simple substring search (no JSON library required).
 *
 * Response shape:
 *   { "content": [ { "type": "text", "text": "<value>" } ] }
 */
static std::string extractAnthropicContent(const std::string& body) {
    // Look for "text": inside the content array
    const std::string key = "\"text\":";
    auto pos = body.find(key);
    if (pos == std::string::npos) {
        throw std::runtime_error("Anthropic response missing 'text' field");
    }
    pos += key.size();

    // Skip whitespace
    while (pos < body.size() && std::isspace(static_cast<unsigned char>(body[pos]))) {
        ++pos;
    }

    if (pos >= body.size() || body[pos] != '"') {
        throw std::runtime_error("Anthropic response 'text' is not a string");
    }
    ++pos; // skip opening quote

    std::string result;
    while (pos < body.size() && body[pos] != '"') {
        if (body[pos] == '\\' && pos + 1 < body.size()) {
            char next = body[pos + 1];
            switch (next) {
                case '"':  result += '"';  pos += 2; break;
                case '\\': result += '\\'; pos += 2; break;
                case 'n':  result += '\n'; pos += 2; break;
                case 'r':  result += '\r'; pos += 2; break;
                case 't':  result += '\t'; pos += 2; break;
                default:   result += next; pos += 2; break;
            }
        } else {
            result += body[pos++];
        }
    }
    return result;
}

// ─── AnthropicAdapter ────────────────────────────────────────────────────────

AnthropicAdapter::AnthropicAdapter(const zcode::core::ProviderConfig& config)
    : config(config)
    , baseURL(config.baseURL.value_or("https://api.anthropic.com"))
    , modelId(config.model.value_or("claude-sonnet-4-20250514"))
{
}

std::string AnthropicAdapter::generateText(
    const std::string& prompt,
    const zcode::core::ProviderOptions& options
) {
    // Build the request body
    // POST /v1/messages — Anthropic Messages API
    std::ostringstream body;
    body << "{"
         << "\"model\":\"" << jsonEscape(modelId) << "\","
         << "\"max_tokens\":" << options.maxTokens.value_or(1024) << ","
         << "\"messages\":[{\"role\":\"user\",\"content\":\"" << jsonEscape(prompt) << "\"}]";

    if (options.temperature.has_value()) {
        body << ",\"temperature\":" << options.temperature.value();
    }
    if (options.systemPrompt.has_value() && !options.systemPrompt->empty()) {
        body << ",\"system\":\"" << jsonEscape(options.systemPrompt.value()) << "\"";
    }
    body << "}";

    const std::string requestBody = body.str();

    // Set up URL
    std::string url = baseURL;
    if (!url.empty() && url.back() == '/') {
        url.pop_back();
    }
    url += "/v1/messages";

    std::string responseBody;
    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize libcurl");
    }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    std::string authHeader = "x-api-key: " + config.apiKey;
    headers = curl_slist_append(headers, authHeader.c_str());
    headers = curl_slist_append(headers, "anthropic-version: 2023-06-01");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, requestBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBody);

    CURLcode res = curl_easy_perform(curl);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        throw std::runtime_error(std::string("Anthropic request failed: ") + curl_easy_strerror(res));
    }

    return extractAnthropicContent(responseBody);
}

} // namespace zcode::provider
