#include "provider/anthropic_adapter.hpp"
#include "provider/http_utils.hpp"

#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

namespace zcode::provider {

// ─── AnthropicAdapter ────────────────────────────────────────────────────────

AnthropicAdapter::AnthropicAdapter(const zcode::core::ProviderConfig& config)
    : apiKey(config.apiKey)
    , baseURL(config.baseURL.value_or("https://api.anthropic.com"))
    , modelId(config.model.value_or("claude-sonnet-4-20250514"))
{}

std::string AnthropicAdapter::generateText(
    const std::string& prompt,
    const zcode::core::ProviderOptions& options
) {
    using json = nlohmann::json;

    // Build request body for the Anthropic Messages API
    json body;
    body["model"]      = modelId;
    body["max_tokens"] = options.maxTokens.value_or(8096);
    body["messages"]   = json::array({
        {{"role", "user"}, {"content", prompt}}
    });

    if (options.temperature.has_value()) {
        body["temperature"] = options.temperature.value();
    }
    if (options.systemPrompt.has_value() && !options.systemPrompt->empty()) {
        body["system"] = options.systemPrompt.value();
    }

    const std::string responseBody = postRequest("/v1/messages", body.dump());

    // Parse response: content[0].text  (first text block)
    const json response = json::parse(responseBody);

    if (!response.contains("content") || !response["content"].is_array()
            || response["content"].empty()) {
        throw std::runtime_error(
            "Anthropic response missing 'content' array. Raw: " + responseBody
        );
    }
    for (const auto& block : response["content"]) {
        if (block.value("type", "") == "text") {
            if (!block.contains("text")) {
                throw std::runtime_error(
                    "Anthropic text block missing 'text' field. Raw: " + responseBody
                );
            }
            return block["text"].get<std::string>();
        }
    }

    throw std::runtime_error(
        "Anthropic response contained no text block. Raw: " + responseBody
    );
}

std::string AnthropicAdapter::postRequest(
    const std::string& endpoint,
    const std::string& jsonBody
) const {
    const std::string url            = baseURL + endpoint;
    const std::string apiKeyHeader   = "x-api-key: " + apiKey;
    // Anthropic requires an API version header
    const std::string versionHeader  = "anthropic-version: 2023-06-01";

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, apiKeyHeader.c_str());
    headers = curl_slist_append(headers, versionHeader.c_str());

    std::string response;
    try {
        response = httpPost(url, jsonBody, headers);
    } catch (...) {
        curl_slist_free_all(headers);
        throw;
    }
    curl_slist_free_all(headers);
    return response;
}

} // namespace zcode::provider
