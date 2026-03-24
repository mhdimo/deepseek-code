cmake_minimum_required(VERSION 3.20)
project(z-code-cpp VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Add include directory
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)

# Dependencies (optional for now - can be added later)
# find_package(nlohmann_json 3.11.0 REQUIRED)
# find_package(curl REQUIRED)
# find_package(sqlite3 REQUIRED)

# Main executable
add_executable(z-code
    src/main.cpp
    src/core/config.cpp
    src/core/types.cpp
    src/provider/registry.cpp
    src/provider/openai_adapter.cpp
    src/provider/anthropic_adapter.cpp
    src/agent/base.cpp
    src/tool/file_tools.cpp
    src/tool/exec_tools.cpp
    src/tool/search_tools.cpp
    src/tui/app.cpp
    src/tui/chat_panel.cpp
    src/tui/text_input.cpp
    src/tui/ui_components.cpp
)

target_include_directories(z-code PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)

target_link_libraries(z-code PRIVATE
    nlohmann_json::nlohmann_json
    CURL::libcurl
    sqlite3
)

# Optional: ncurses for terminal UI
find_package(Curses)
if(CURSES_FOUND)
    target_link_libraries(z-code PRIVATE ${CURSES_LIBRARIES})
    target_include_directories(z-code PRIVATE ${CURSES_INCLUDE_DIRS})
endif()

# Compiler flags
if(MSVC)
    target_compile_options(z-code PRIVATE /W4)
else()
    target_compile_options(z-code PRIVATE -Wall -Wextra -Wpedantic)
endif()
