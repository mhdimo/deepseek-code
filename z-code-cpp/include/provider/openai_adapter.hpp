#pragma once

#include "registry.hpp"
#include "../core/types.hpp"
#include <string>

namespace zcode::provider {

/**
 * OpenAI-compatible adapter.
 * Works with any provider implementing the Chat Completions API:
 * OpenAI, GLM/Z.AI, DeepSeek, Groq, Together, Mistral, Ollama, LM Studio, etc.
 * Set config.baseURL to override the default endpoint.
 */
class OpenAIAdapter : public LanguageModel {
public:
    explicit OpenAIAdapter(const zcode::core::ProviderConfig& config);
    ~OpenAIAdapter() override = default;

    /**
     * Call the model via the Chat Completions API and return the response text.
     * Endpoint: POST {baseURL}/chat/completions
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
