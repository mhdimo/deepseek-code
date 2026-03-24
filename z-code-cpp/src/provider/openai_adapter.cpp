#include "provider/openai_adapter.hpp"
#include "provider/http_utils.hpp"

#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

namespace zcode::provider {

// ─── OpenAIAdapter ───────────────────────────────────────────────────────────

OpenAIAdapter::OpenAIAdapter(const zcode::core::ProviderConfig& config)
    : apiKey(config.apiKey)
    , baseURL(config.baseURL.value_or("https://api.openai.com/v1"))
    , modelId(config.model.value_or("gpt-4o"))
{}

std::string OpenAIAdapter::generateText(
    const std::string& prompt,
    const zcode::core::ProviderOptions& options
) {
    using json = nlohmann::json;

    // Build request body mirroring the AI SDK Chat Completions call
    json body;
    body["model"] = modelId;

    if (options.systemPrompt.has_value() && !options.systemPrompt->empty()) {
        body["messages"] = json::array({
            {{"role", "system"}, {"content", options.systemPrompt.value()}},
            {{"role", "user"},   {"content", prompt}}
        });
    } else {
        body["messages"] = json::array({
            {{"role", "user"}, {"content", prompt}}
        });
    }

    if (options.maxTokens.has_value()) {
        body["max_tokens"] = options.maxTokens.value();
    }
    if (options.temperature.has_value()) {
        body["temperature"] = options.temperature.value();
    }

    const std::string responseBody = postRequest("/chat/completions", body.dump());

    // Parse response: choices[0].message.content
    const json response = json::parse(responseBody);

    if (!response.contains("choices") || !response["choices"].is_array()
            || response["choices"].empty()) {
        throw std::runtime_error(
            "OpenAI response missing 'choices' array. Raw: " + responseBody
        );
    }
    const auto& choice = response["choices"][0];
    if (!choice.contains("message") || !choice["message"].contains("content")) {
        throw std::runtime_error(
            "OpenAI response missing 'choices[0].message.content'. Raw: " + responseBody
        );
    }
    return choice["message"]["content"].get<std::string>();
}

std::string OpenAIAdapter::postRequest(
    const std::string& endpoint,
    const std::string& jsonBody
) const {
    const std::string url           = baseURL + endpoint;
    const std::string authHeader    = "Authorization: Bearer " + apiKey;

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, authHeader.c_str());

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

