/*
# -*- coding: utf-8 -*-

# Original Python umsc Author: Osmanjan Tursun
# C++ umsc Author: Piyazon
# Licence: MIT License

This is a simple script to convert Uyghur texts written
in different Uyghur scripts. It supports Uyghur Arabic,
Latin Common Turkish scripts, Uyghur Latin Script (also
known as computer script), Uyghur Yengi (new) script and
Uyghur Cyrillic script.

Abbreviations used in this file:

ULS | Uyghur Latin Script
UYS | Uyghur Yengi (New) Script
CPS | Chinese Pinyin Script
UAS | Uyghur Arabic Script
CTS | Common Turkic Script
UCS | Uyghur Cyrillic Script
XJU | Xinjiang University English Case Sensitive
UZLS | Uzbek Latin Script
*/

#pragma once
#ifndef UMMSC_CPP_HEADER
#define UMMSC_CPP_HEADER

#include <string>
#include <vector>

class umsc {
public:
    umsc(std::string source_script = "", std::string target_script = "");
    ~umsc();

    void set_source_script(const std::string& source_script);
    void set_target_script(const std::string& target_script);

    std::string convert(
        const std::string& text,
        const std::string& source_script = "",
        const std::string& target_script = "") const;

    std::string operator()(
        const std::string& text,
        const std::string& source_script = "",
        const std::string& target_script = "") const;

    static bool is_pure_uyghur_script(const std::string& text);

private:
    std::string source_script_;
    std::string target_script_;

    static std::string normalize_script_name(const std::string& script);

    static std::u32string utf8_to_u32(const std::string& text);
    static std::string u32_to_utf8(const std::u32string& text);
    static std::u32string to_lower_ascii(const std::u32string& text);
    static std::u32string replace_all(
        std::u32string text,
        const std::u32string& from,
        const std::u32string& to);
    static std::u32string replace_via_table(
        std::u32string text,
        const std::vector<std::u32string>& from,
        const std::vector<std::u32string>& to);
    static bool contains_codepoint_in_range(
        const std::u32string& text,
        char32_t begin,
        char32_t end);

    static bool is_cts_vowel(char32_t cp);
    static bool is_cts_letter(char32_t cp);
    static bool is_cts_non_vowel_letter(char32_t cp);
    static bool is_xjus_non_vowel_letter(char32_t cp);
    static bool is_uas_vowel(char32_t cp);

    static std::u32string revise_cts(
        const std::u32string& text,
        bool keep_apostrophes);
    static std::u32string revise_uas(const std::u32string& text);
    static std::u32string add_hamza_before_vowels(const std::u32string& text);
    static std::u32string add_xjus_vowels(const std::u32string& text);

    static const std::vector<std::u32string>& uas_group1();
    static const std::vector<std::u32string>& cts_group1();
    static const std::vector<std::u32string>& ucs_group1();
    static const std::vector<std::u32string>& ipa_group1();

    static std::u32string UAS2CTS_impl(
        const std::u32string& text,
        bool keep_apostrophe);
    static std::u32string ULS2CTS_impl(const std::u32string& text);
    static std::u32string UYS2CTS_impl(const std::u32string& text);
    static std::u32string UCS2CTS_impl(const std::u32string& text);
    static std::u32string XJUS2CTS_impl(const std::u32string& text);
    static std::u32string XJUS2UAS_impl(const std::u32string& text);
    static std::u32string UZLS2CTS_impl(const std::u32string& text);

    static std::u32string CTS2UAS_impl(const std::u32string& text);
    static std::u32string CTS2ULS_impl(const std::u32string& text);
    static std::u32string CTS2UYS_impl(const std::u32string& text);
    static std::u32string CTS2IPA_impl(const std::u32string& text);
    static std::u32string CTS2UZLS_impl(const std::u32string& text);
    static std::u32string CTS2XJUS_impl(const std::u32string& text);
    static std::u32string CTS2UCS_impl(const std::u32string& text);

    static std::u32string convert_u32(
        const std::u32string& text,
        const std::string& source_script,
        const std::string& target_script);
};

#endif // !UMMSC_CPP_HEADER
