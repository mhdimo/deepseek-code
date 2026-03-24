#pragma once

#include "../core/types.hpp"
#include <string>
#include <vector>

namespace zcode::tui {

class Terminal {
public:
    Terminal();
    ~Terminal();

    // Initialization
    void init();
    void shutdown();
    
    // Rendering
    void clear();
    void render(const std::vector<zcode::core::Message>& messages);
    
    // Input
    std::string readInput();
    
    // UI Components
    void displayChatPanel(const std::vector<zcode::core::Message>& messages);
    void displayTextInput();
    void displayStatusBar(const std::string& status);
    void displayToolBlock(const zcode::core::ToolUseBlock& block);
    void displaySpinner(const std::string& text);

private:
    bool initialized = false;
};

/**
 * Application - Main TUI app orchestrator
 * Manages state, event handling, and component rendering
 */
class App {
public:
    App(const zcode::core::ProviderConfig& providerConfig);
    ~App();

    /**
     * Run the application main loop
     */
    void run();

private:
    Terminal terminal;
    zcode::core::SessionState sessionState;
    zcode::core::ProviderConfig providerConfig;
    bool running = true;

    void handleInput(const std::string& input);
    void onAgentEvent(const zcode::core::AgentEvent& event);
    void renderUI();
};

} // namespace zcode::tui
