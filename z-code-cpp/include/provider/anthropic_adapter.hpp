#pragma once

#include "registry.hpp"
#include "../core/types.hpp"
#include <string>

namespace zcode::provider {

/**
 * Anthropic adapter.
 * Calls the Anthropic Messages API (/v1/messages).
 * Set config.baseURL to override the default endpoint (useful for proxies).
 */
class AnthropicAdapter : public LanguageModel {
public:
    explicit AnthropicAdapter(const zcode::core::ProviderConfig& config);
    ~AnthropicAdapter() override = default;

    /**
     * Call the model via the Anthropic Messages API and return the response text.
     * Endpoint: POST {baseURL}/v1/messages
     */
    std::string generateText(
        const std::string& prompt,
        const zcode::core::ProviderOptions& options
    ) override;

private:
    zcode::core::ProviderConfig config;
    std::string baseURL;   // effective endpoint (default or overridden)
    std::string modelId;   // effective model ID (default or from config)
};

} // namespace zcode::provider
