#pragma once

#include "registry.hpp"
#include "../core/types.hpp"
#include <string>

namespace zcode::provider {

/**
 * Anthropic adapter.
 *
 * Calls the Anthropic Messages API (/v1/messages).
 * Extended thinking is surfaced through the optional thinking blocks
 * but is not forwarded to the caller in this minimal implementation.
 */
class AnthropicAdapter : public LanguageModel {
public:
    explicit AnthropicAdapter(const zcode::core::ProviderConfig& config);
    ~AnthropicAdapter() override = default;

    std::string generateText(
        const std::string& prompt,
        const zcode::core::ProviderOptions& options
    ) override;

private:
    std::string apiKey;
    std::string baseURL;
    std::string modelId;

    /** POST body → response text via libcurl */
    std::string postRequest(
        const std::string& endpoint,
        const std::string& jsonBody
    ) const;
};

} // namespace zcode::provider
