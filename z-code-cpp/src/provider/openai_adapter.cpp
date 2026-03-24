#include "provider/openai_adapter.hpp"
#include "provider/http_utils.hpp"
#include <curl/curl.h>
#include <stdexcept>
#include <sstream>
#include <string>

namespace zcode::provider {

using detail::writeCallback;
using detail::jsonEscape;

/**
 * Extract the first "content" string value from an OpenAI Chat Completions
 * response body using simple substring search (no JSON library required).
 *
 * Response shape:
 *   { "choices": [ { "message": { "content": "<text>" } } ] }
 */
static std::string extractOpenAIContent(const std::string& body) {
    // Look for "content":
    const std::string key = "\"content\":";
    auto pos = body.find(key);
    if (pos == std::string::npos) {
        throw std::runtime_error("OpenAI response missing 'content' field");
    }
    pos += key.size();

    // Skip whitespace
    while (pos < body.size() && std::isspace(static_cast<unsigned char>(body[pos]))) {
        ++pos;
    }

    if (pos >= body.size() || body[pos] != '"') {
        throw std::runtime_error("OpenAI response 'content' is not a string");
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

// ─── OpenAIAdapter ───────────────────────────────────────────────────────────

OpenAIAdapter::OpenAIAdapter(const zcode::core::ProviderConfig& config)
    : config(config)
    , baseURL(config.baseURL.value_or("https://api.openai.com/v1"))
    , modelId(config.model.value_or("gpt-4o"))
{
}

std::string OpenAIAdapter::generateText(
    const std::string& prompt,
    const zcode::core::ProviderOptions& options
) {
    // Build the request body
    // POST /chat/completions — Chat Completions API
    // System prompt is sent as the first message with role "system".
    std::ostringstream body;
    body << "{"
         << "\"model\":\"" << jsonEscape(modelId) << "\","
         << "\"messages\":[";

    if (options.systemPrompt.has_value() && !options.systemPrompt->empty()) {
        body << "{\"role\":\"system\",\"content\":\"" << jsonEscape(options.systemPrompt.value()) << "\"},";
    }
    body << "{\"role\":\"user\",\"content\":\"" << jsonEscape(prompt) << "\"}]";

    if (options.maxTokens.has_value()) {
        body << ",\"max_tokens\":" << options.maxTokens.value();
    }
    if (options.temperature.has_value()) {
        body << ",\"temperature\":" << options.temperature.value();
    }
    body << "}";

    const std::string requestBody = body.str();

    // Set up headers
    std::string url = baseURL;
    if (!url.empty() && url.back() == '/') {
        url.pop_back();
    }
    url += "/chat/completions";

    std::string responseBody;
    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize libcurl");
    }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    std::string authHeader = "Authorization: Bearer " + config.apiKey;
    headers = curl_slist_append(headers, authHeader.c_str());

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
        throw std::runtime_error(std::string("OpenAI request failed: ") + curl_easy_strerror(res));
    }

    return extractOpenAIContent(responseBody);
}

} // namespace zcode::provider
