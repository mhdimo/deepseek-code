#pragma once

#include "../core/types.hpp"
#include <string>
#include <memory>

namespace zcode::provider {

// Forward declaration
class LanguageModel {
public:
    virtual ~LanguageModel() = default;
    
    /**
     * Call the model and return the response
     */
    virtual std::string generateText(
        const std::string& prompt,
        const zcode::core::ProviderOptions& options
    ) = 0;
};

/**
 * Provider Registry
 * Manages model creation based on provider configuration
 */
class ProviderRegistry {
public:
    /**
     * Create a LanguageModel instance from configuration
     */
    static std::unique_ptr<LanguageModel> createModel(
        const zcode::core::ProviderConfig& config
    );
};

/**
 * Factory functions for creating provider-specific model instances.
 * Defined in the respective adapter translation units.
 */
std::unique_ptr<LanguageModel> createOpenAIModel(
    const zcode::core::ProviderConfig& config
);

std::unique_ptr<LanguageModel> createAnthropicModel(
    const zcode::core::ProviderConfig& config
);

} // namespace zcode::provider
