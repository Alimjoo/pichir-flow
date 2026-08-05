cmake_minimum_required(VERSION 3.15)
project(ASR LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Threads REQUIRED)

if(NOT DEFINED BUILD_SHARED_LIBS)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build shared libraries")
endif()

set(ASIO_INCLUDE_DIR
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/asio-asio-1-24-0/asio/include"
)

if(NOT EXISTS "${ASIO_INCLUDE_DIR}/asio.hpp")
    message(FATAL_ERROR "Local Asio not found at: ${ASIO_INCLUDE_DIR}")
endif()

set(LOCAL_WEBSOCKETPP_INCLUDE_DIR
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/websocketpp"
)

set(WEBSOCKETPP_INCLUDE_DIR "" CACHE PATH "Path to the WebSocket++ include root")

if(WEBSOCKETPP_INCLUDE_DIR)
    if(NOT EXISTS "${WEBSOCKETPP_INCLUDE_DIR}/websocketpp/server.hpp")
        message(FATAL_ERROR "websocketpp/server.hpp not found in: ${WEBSOCKETPP_INCLUDE_DIR}")
    endif()
elseif(EXISTS "${LOCAL_WEBSOCKETPP_INCLUDE_DIR}/websocketpp/server.hpp")
    set(WEBSOCKETPP_INCLUDE_DIR "${LOCAL_WEBSOCKETPP_INCLUDE_DIR}")
else()
    find_path(WEBSOCKETPP_INCLUDE_DIR websocketpp/server.hpp)

    if(NOT WEBSOCKETPP_INCLUDE_DIR)
        message(FATAL_ERROR "websocketpp not found. Expected bundled headers at: ${LOCAL_WEBSOCKETPP_INCLUDE_DIR}")
    endif()
endif()

set(DEFAULT_WHISPER_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../whisper.cpp")

if(NOT EXISTS "${DEFAULT_WHISPER_CPP_DIR}/CMakeLists.txt"
        AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../whispercpp_new/CMakeLists.txt")
    set(DEFAULT_WHISPER_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../whispercpp_new")
endif()

set(WHISPER_CPP_DIR
    "${DEFAULT_WHISPER_CPP_DIR}"
    CACHE PATH "Path to the ASR engine source directory"
)

if(NOT EXISTS "${WHISPER_CPP_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "ASR engine source not found. Set WHISPER_CPP_DIR to the ASR engine source directory.")
endif()

set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)

add_subdirectory("${WHISPER_CPP_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/whisper.cpp-build")

if(DEFINED BUILD_SHARED_LIBS)
    set(ASR_HAD_BUILD_SHARED_LIBS ON)
    set(ASR_BUILD_SHARED_LIBS_RESTORE "${BUILD_SHARED_LIBS}")
endif()

set(BUILD_SHARED_LIBS OFF)
add_subdirectory("third_party/UMSC-CPP")

if(ASR_HAD_BUILD_SHARED_LIBS)
    set(BUILD_SHARED_LIBS "${ASR_BUILD_SHARED_LIBS_RESTORE}")
else()
    unset(BUILD_SHARED_LIBS)
endif()

add_executable(${PROJECT_NAME}
    server.cpp
    # test_improve.cpp
)

set(TAURI_SERVER_DIR "${CMAKE_CURRENT_SOURCE_DIR}/frontend/src-tauri/server")
set(TAURI_DEBUG_SERVER_DIR "${CMAKE_CURRENT_SOURCE_DIR}/frontend/src-tauri/target/debug/server")

if(EXISTS "${TAURI_SERVER_DIR}")
    add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:${PROJECT_NAME}>"
            "${TAURI_SERVER_DIR}/$<TARGET_FILE_NAME:${PROJECT_NAME}>"
        COMMAND ${CMAKE_COMMAND} -E make_directory
            "${TAURI_DEBUG_SERVER_DIR}"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:${PROJECT_NAME}>"
            "${TAURI_DEBUG_SERVER_DIR}/$<TARGET_FILE_NAME:${PROJECT_NAME}>"
    )
endif()

target_compile_definitions(${PROJECT_NAME} PRIVATE
    ASIO_STANDALONE
    _WEBSOCKETPP_CPP11_STL_
)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${ASIO_INCLUDE_DIR}
    ${WEBSOCKETPP_INCLUDE_DIR}
)

target_link_libraries(${PROJECT_NAME} PRIVATE
    whisper
    UMSC-CPP
    Threads::Threads
)

if(WIN32)
    target_link_libraries(${PROJECT_NAME} PRIVATE
        ws2_32
        mswsock
    )
endif()
