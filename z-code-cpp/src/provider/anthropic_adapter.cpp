// Anthropic API adapter
#include "provider/registry.hpp"

namespace zcode::provider {

class AnthropicModel : public LanguageModel {
public:
    AnthropicModel(const zcode::core::ProviderConfig& config) : config(config) {}
    
    std::string generateText(
        const std::string& prompt,
        const zcode::core::ProviderOptions& options
    ) override;
    
private:
    zcode::core::ProviderConfig config;
};

std::string AnthropicModel::generateText(
    const std::string& prompt,
    const zcode::core::ProviderOptions& options
) {
    // TODO: Implement HTTP calls to Anthropic API
    return "Anthropic response";
}

std::unique_ptr<LanguageModel> createAnthropicModel(
    const zcode::core::ProviderConfig& config
) {
    return std::make_unique<AnthropicModel>(config);
}

} // namespace zcode::provider
