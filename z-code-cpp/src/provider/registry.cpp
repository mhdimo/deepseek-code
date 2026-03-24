#include "provider/registry.hpp"
#include <memory>
#include <stdexcept>

namespace zcode::provider {

std::unique_ptr<LanguageModel> ProviderRegistry::createModel(
    const zcode::core::ProviderConfig& config
) {
    switch (config.type) {
        case zcode::core::ProviderType::OpenAI:
            return createOpenAIModel(config);
        case zcode::core::ProviderType::Anthropic:
            return createAnthropicModel(config);
        default:
            throw std::invalid_argument("Unsupported provider type");
    }
}

} // namespace zcode::provider
