#pragma once

#include <curl/curl.h>
#include <stdexcept>
#include <string>

namespace zcode::provider {

/** libcurl write callback — appends received bytes to a std::string buffer. */
inline std::size_t curlWriteCallback(
    void* contents, std::size_t size, std::size_t nmemb, std::string* buffer
) {
    buffer->append(static_cast<char*>(contents), size * nmemb);
    return size * nmemb;
}

/**
 * Perform an HTTP POST with JSON body and return the raw response string.
 *
 * @param url        Full URL to POST to.
 * @param jsonBody   JSON-encoded request body.
 * @param headers    Null-terminated list of "Key: Value" header strings.
 */
inline std::string httpPost(
    const std::string& url,
    const std::string& jsonBody,
    struct curl_slist* headers
) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize libcurl");
    }

    std::string responseBuffer;

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBuffer);

    const CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        throw std::runtime_error(
            std::string("curl request failed: ") + curl_easy_strerror(res)
        );
    }

    return responseBuffer;
}

} // namespace zcode::provider
