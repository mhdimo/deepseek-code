#include "provider/registry.hpp"
#include "provider/openai_adapter.hpp"
#include "provider/anthropic_adapter.hpp"
#include <memory>

namespace zcode::provider {

std::unique_ptr<LanguageModel> ProviderRegistry::createModel(
    const zcode::core::ProviderConfig& config
) {
    switch (config.type) {
        case zcode::core::ProviderType::Anthropic:
            return std::make_unique<AnthropicAdapter>(config);

        case zcode::core::ProviderType::OpenAI:
            // Fall through — OpenAI-compatible adapter is the default
        default:
            return std::make_unique<OpenAIAdapter>(config);
    }
}

} // namespace zcode::provider
