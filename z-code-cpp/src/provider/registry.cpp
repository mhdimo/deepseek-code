#include "provider/registry.hpp"
#include <memory>

namespace zcode::provider {

std::unique_ptr<LanguageModel> ProviderRegistry::createModel(
    const zcode::core::ProviderConfig& config
) {
    // TODO: Implement provider-specific model creation
    // Return OpenAI adapter or Anthropic adapter based on config.type
    return nullptr;
}

} // namespace zcode::provider
