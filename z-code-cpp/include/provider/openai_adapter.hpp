#pragma once

#include "registry.hpp"
#include "../core/types.hpp"
#include <string>

namespace zcode::provider {

/**
 * OpenAI-compatible adapter.
 *
 * Works with any provider implementing the OpenAI Chat Completions API:
 *   OpenAI, GLM/Z.AI, DeepSeek, Groq, Together, Mistral, LM Studio, Ollama, …
 * Just set baseURL to the endpoint.
 */
class OpenAIAdapter : public LanguageModel {
public:
    explicit OpenAIAdapter(const zcode::core::ProviderConfig& config);
    ~OpenAIAdapter() override = default;

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
