#include "provider/registry.hpp"
#include "provider/openai_adapter.hpp"
#include "provider/anthropic_adapter.hpp"
#include <memory>
#include <stdexcept>

namespace zcode::provider {

std::unique_ptr<LanguageModel> ProviderRegistry::createModel(
    const zcode::core::ProviderConfig& config
) {
    switch (config.type) {
        case zcode::core::ProviderType::Anthropic:
            return std::make_unique<AnthropicAdapter>(config);

        case zcode::core::ProviderType::OpenAI:
            // Falls through — OpenAI-compatible is the default
            [[fallthrough]];

        default:
            // OpenAI-compatible adapter works for any endpoint that implements
            // Chat Completions semantics (OpenAI, GLM, DeepSeek, Groq, …).
            return std::make_unique<OpenAIAdapter>(config);
    }
}

} // namespace zcode::provider
