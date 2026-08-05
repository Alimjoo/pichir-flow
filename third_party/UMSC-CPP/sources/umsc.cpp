#include "umsc.h"

#include <algorithm>
#include <stdexcept>

namespace {
constexpr char32_t kHamza = U'\u0626';

bool starts_with(const std::u32string& text, std::size_t pos, const std::u32string& needle) {
    if (needle.empty() || pos + needle.size() > text.size()) {
        return false;
    }

    for (std::size_t i = 0; i < needle.size(); ++i) {
        if (text[pos + i] != needle[i]) {
            return false;
        }
    }

    return true;
}
} // namespace

umsc::umsc(std::string source_script, std::string target_script)
    : source_script_(normalize_script_name(source_script)),
      target_script_(normalize_script_name(target_script)) {}

umsc::~umsc() = default;

void umsc::set_source_script(const std::string& source_script) {
    source_script_ = normalize_script_name(source_script);
}

void umsc::set_target_script(const std::string& target_script) {
    target_script_ = normalize_script_name(target_script);
}

std::string umsc::convert(
    const std::string& text,
    const std::string& source_script,
    const std::string& target_script) const {
    const std::string effective_source =
        source_script.empty() ? source_script_ : normalize_script_name(source_script);
    const std::string effective_target =
        target_script.empty() ? target_script_ : normalize_script_name(target_script);

    if (effective_source.empty() || effective_target.empty()) {
        throw std::invalid_argument("source and target scripts must be provided");
    }

    if (effective_source == effective_target) {
        return text;
    }

    return u32_to_utf8(convert_u32(utf8_to_u32(text), effective_source, effective_target));
}

std::string umsc::operator()(
    const std::string& text,
    const std::string& source_script,
    const std::string& target_script) const {
    return convert(text, source_script, target_script);
}

bool umsc::is_pure_uyghur_script(const std::string& text) {
    return contains_codepoint_in_range(utf8_to_u32(text), U'\u0621', U'\u06ff');
}

std::string umsc::normalize_script_name(const std::string& script) {
    std::string normalized = script;
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
        return static_cast<char>(std::toupper(ch));
    });
    return normalized;
}

std::u32string umsc::utf8_to_u32(const std::string& text) {
    std::u32string result;
    result.reserve(text.size());

    for (std::size_t i = 0; i < text.size();) {
        const unsigned char lead = static_cast<unsigned char>(text[i]);
        char32_t codepoint = 0;
        std::size_t width = 0;

        if ((lead & 0x80u) == 0) {
            codepoint = lead;
            width = 1;
        } else if ((lead & 0xE0u) == 0xC0u) {
            codepoint = lead & 0x1Fu;
            width = 2;
        } else if ((lead & 0xF0u) == 0xE0u) {
            codepoint = lead & 0x0Fu;
            width = 3;
        } else if ((lead & 0xF8u) == 0xF0u) {
            codepoint = lead & 0x07u;
            width = 4;
        } else {
            throw std::runtime_error("invalid UTF-8 leading byte");
        }

        if (i + width > text.size()) {
            throw std::runtime_error("truncated UTF-8 sequence");
        }

        for (std::size_t j = 1; j < width; ++j) {
            const unsigned char continuation = static_cast<unsigned char>(text[i + j]);
            if ((continuation & 0xC0u) != 0x80u) {
                throw std::runtime_error("invalid UTF-8 continuation byte");
            }
            codepoint = (codepoint << 6) | (continuation & 0x3Fu);
        }

        result.push_back(codepoint);
        i += width;
    }

    return result;
}

std::string umsc::u32_to_utf8(const std::u32string& text) {
    std::string result;

    for (const char32_t codepoint : text) {
        if (codepoint <= 0x7F) {
            result.push_back(static_cast<char>(codepoint));
        } else if (codepoint <= 0x7FF) {
            result.push_back(static_cast<char>(0xC0 | ((codepoint >> 6) & 0x1F)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else if (codepoint <= 0xFFFF) {
            result.push_back(static_cast<char>(0xE0 | ((codepoint >> 12) & 0x0F)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else if (codepoint <= 0x10FFFF) {
            result.push_back(static_cast<char>(0xF0 | ((codepoint >> 18) & 0x07)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else {
            throw std::runtime_error("invalid Unicode code point");
        }
    }

    return result;
}

std::u32string umsc::to_lower_ascii(const std::u32string& text) {
    std::u32string lowered = text;
    for (char32_t& cp : lowered) {
        if (cp >= U'A' && cp <= U'Z') {
            cp = cp - U'A' + U'a';
        }
    }
    return lowered;
}

std::u32string umsc::replace_all(
    std::u32string text,
    const std::u32string& from,
    const std::u32string& to) {
    if (from.empty()) {
        return text;
    }

    std::size_t pos = 0;
    while ((pos = text.find(from, pos)) != std::u32string::npos) {
        text.replace(pos, from.size(), to);
        pos += to.size();
    }
    return text;
}

std::u32string umsc::replace_via_table(
    std::u32string text,
    const std::vector<std::u32string>& from,
    const std::vector<std::u32string>& to) {
    const std::size_t count = std::min(from.size(), to.size());
    for (std::size_t i = 0; i < count; ++i) {
        text = replace_all(std::move(text), from[i], to[i]);
    }
    return text;
}

bool umsc::contains_codepoint_in_range(
    const std::u32string& text,
    char32_t begin,
    char32_t end) {
    return std::any_of(text.begin(), text.end(), [begin, end](char32_t cp) {
        return cp >= begin && cp <= end;
    });
}

bool umsc::is_cts_vowel(char32_t cp) {
    return cp == U'a' || cp == U'e' || cp == U'é' || cp == U'i' ||
           cp == U'o' || cp == U'u' || cp == U'ö' || cp == U'ü';
}

bool umsc::is_cts_letter(char32_t cp) {
    static const std::vector<char32_t> letters = {
        U'a', U'e', U'b', U'p', U't', U'c', U'ç', U'x', U'd', U'r', U'z', U'j',
        U's', U'ş', U'f', U'ñ', U'l', U'm', U'h', U'o', U'u', U'ö', U'ü', U'v',
        U'é', U'i', U'y', U'q', U'k', U'g', U'n', U'ğ'
    };
    return std::find(letters.begin(), letters.end(), cp) != letters.end();
}

bool umsc::is_cts_non_vowel_letter(char32_t cp) {
    return is_cts_letter(cp) && !is_cts_vowel(cp);
}

bool umsc::is_xjus_non_vowel_letter(char32_t cp) {
    static const std::vector<char32_t> letters = {
        U'b', U'p', U't', U'c', U'x', U'd', U'r', U'z', U'j', U'J', U's', U'x',
        U'f', U'N', U'l', U'm', U'h', U'H', U'y', U'q', U'k', U'g', U'n', U'G', U'w'
    };
    return std::find(letters.begin(), letters.end(), cp) != letters.end();
}

bool umsc::is_uas_vowel(char32_t cp) {
    return cp == U'ا' || cp == U'ە' || cp == U'ې' || cp == U'ى' ||
           cp == U'و' || cp == U'ۇ' || cp == U'ۆ' || cp == U'ۈ';
}

std::u32string umsc::revise_cts(const std::u32string& text, bool keep_apostrophes) {
    std::u32string without_hamza;
    without_hamza.reserve(text.size());

    for (std::size_t i = 0; i < text.size(); ++i) {
        const char32_t current = text[i];
        if (current == kHamza) {
            const bool remove_at_word_start =
                i == 0 || !is_cts_letter(text[i - 1]);
            if (remove_at_word_start) {
                continue;
            }

            if (!keep_apostrophes && i > 0 && is_cts_vowel(text[i - 1])) {
                continue;
            }

            without_hamza.push_back(U'\'');
            continue;
        }

        without_hamza.push_back(current);
    }

    return without_hamza;
}

std::u32string umsc::revise_uas(const std::u32string& text) {
    std::u32string revised;
    revised.reserve(text.size() * 2);

    for (std::size_t i = 0; i < text.size(); ++i) {
        const char32_t current = text[i];
        const char32_t previous = i == 0 ? U'\0' : text[i - 1];

        const bool should_prefix_hamza =
            is_uas_vowel(current) &&
            (i == 0 || previous == U'-' || previous == U' ' || is_uas_vowel(previous));

        if (should_prefix_hamza) {
            revised.push_back(U'ئ');
        }

        revised.push_back(current);
    }

    return revised;
}

std::u32string umsc::add_hamza_before_vowels(const std::u32string& text) {
    std::u32string revised;
    revised.reserve(text.size() * 2);

    for (std::size_t i = 0; i < text.size(); ++i) {
        const char32_t current = text[i];
        const char32_t previous = i == 0 ? U'\0' : text[i - 1];

        if (is_cts_vowel(current) && (i == 0 || !is_cts_non_vowel_letter(previous))) {
            revised.push_back(kHamza);
        }

        revised.push_back(current);
    }

    return revised;
}

std::u32string umsc::add_xjus_vowels(const std::u32string& text) {
    std::u32string revised;
    revised.reserve(text.size() * 2);

    for (std::size_t i = 0; i < text.size(); ++i) {
        const char32_t current = text[i];
        const char32_t previous = i == 0 ? U'\0' : text[i - 1];
        const bool is_vowel =
            current == U'a' || current == U'A' || current == U'e' ||
            current == U'i' || current == U'o' || current == U'u' ||
            current == U'O' || current == U'U';

        if (is_vowel && (i == 0 || !is_xjus_non_vowel_letter(previous))) {
            revised.push_back(U'v');
        }

        revised.push_back(current);
    }

    return revised;
}

const std::vector<std::u32string>& umsc::uas_group1() {
    static const std::vector<std::u32string> data = {
        U"ا", U"ە", U"ب", U"پ", U"ت", U"ج", U"چ", U"خ", U"د", U"ر", U"ز", U"ژ",
        U"س", U"ش", U"ف", U"ڭ", U"ل", U"لا", U"م", U"ھ", U"و", U"ۇ", U"ۆ", U"ۈ",
        U"ۋ", U"ې", U"ى", U"ي", U"ق", U"ك", U"گ", U"ن", U"غ", U"؟", U"،", U"؛", U"٭"
    };
    return data;
}

const std::vector<std::u32string>& umsc::cts_group1() {
    static const std::vector<std::u32string> data = {
        U"a", U"e", U"b", U"p", U"t", U"c", U"ç", U"x", U"d", U"r", U"z", U"j",
        U"s", U"ş", U"f", U"ñ", U"l", U"la", U"m", U"h", U"o", U"u", U"ö", U"ü",
        U"v", U"é", U"i", U"y", U"q", U"k", U"g", U"n", U"ğ", U"?", U",", U";", U"*"
    };
    return data;
}

const std::vector<std::u32string>& umsc::ucs_group1() {
    static const std::vector<std::u32string> data = {
        U"а", U"ә", U"б", U"п", U"т", U"җ", U"ч", U"х", U"д", U"р", U"з", U"ж",
        U"с", U"ш", U"ф", U"ң", U"л", U"ла", U"м", U"һ", U"о", U"у", U"ө", U"ү",
        U"в", U"е", U"и", U"й", U"қ", U"к", U"г", U"н", U"ғ", U"?", U",", U";", U"*"
    };
    return data;
}

const std::vector<std::u32string>& umsc::ipa_group1() {
    static const std::vector<std::u32string> data = {
        U"ɑ", U"æ", U"b", U"p", U"t", U"dʒ", U"tʃ", U"χ", U"d", U"r", U"z", U"ʒ",
        U"s", U"ʃ", U"f", U"ŋ", U"l", U"la", U"m", U"h", U"o", U"u", U"ø", U"y",
        U"w", U"ɛ", U"i", U"j", U"q", U"k", U"ɡ", U"n", U"ʁ", U"?", U",", U";", U"*"
    };
    return data;
}

std::u32string umsc::UAS2CTS_impl(const std::u32string& text, bool keep_apostrophe) {
    return revise_cts(replace_via_table(text, uas_group1(), cts_group1()), keep_apostrophe);
}

std::u32string umsc::ULS2CTS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_all(std::move(revised), U"j", U"c");
    revised = replace_all(std::move(revised), U"ng", U"ñ");
    revised = replace_all(std::move(revised), U"n'g", U"ng'");
    revised = replace_all(std::move(revised), U"'ng", U"ñ");
    revised = replace_all(std::move(revised), U"ch", U"ç");
    revised = replace_all(std::move(revised), U"zh", U"j");
    revised = replace_all(std::move(revised), U"sh", U"ş");
    revised = replace_all(std::move(revised), U"'gh", U"ğ");
    revised = replace_all(std::move(revised), U"gh", U"ğ");
    revised = replace_all(std::move(revised), U"w", U"v");
    revised = replace_all(std::move(revised), U"ch", U"ç");
    revised = replace_all(std::move(revised), U"ó", U"o");
    return revised;
}

std::u32string umsc::UYS2CTS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_all(std::move(revised), U"e", U"é");
    revised = replace_all(std::move(revised), U"ə", U"e");
    revised = replace_all(std::move(revised), U"j", U"c");
    revised = replace_all(std::move(revised), U"q", U"ç");
    revised = replace_all(std::move(revised), U"ⱬ", U"j");
    revised = replace_all(std::move(revised), U"x", U"ş");
    revised = replace_all(std::move(revised), U"h", U"x");
    revised = replace_all(std::move(revised), U"ⱨ", U"h");
    revised = replace_all(std::move(revised), U"ng", U"ñ");
    revised = replace_all(std::move(revised), U"ø", U"ö");
    revised = replace_all(std::move(revised), U"ü", U"ü");
    revised = replace_all(std::move(revised), U"w", U"v");
    revised = replace_all(std::move(revised), U"ⱪ", U"q");
    revised = replace_all(std::move(revised), U"ƣ", U"ğ");
    return revised;
}

std::u32string umsc::UCS2CTS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_via_table(std::move(revised), ucs_group1(), cts_group1());
    revised = replace_all(std::move(revised), U"я", U"ya");
    revised = replace_all(std::move(revised), U"ю", U"yu");
    return revised;
}

std::u32string umsc::XJUS2CTS_impl(const std::u32string& text) {
    std::u32string revised = text;
    revised = replace_all(std::move(revised), U"v", U"\u0626");
    revised = replace_all(std::move(revised), U"J", U"j");
    revised = replace_all(std::move(revised), U"c", U"ç");
    revised = replace_all(std::move(revised), U"j", U"c");
    revised = replace_all(std::move(revised), U"x", U"ş");
    revised = replace_all(std::move(revised), U"H", U"x");
    revised = replace_all(std::move(revised), U"N", U"ñ");
    revised = replace_all(std::move(revised), U"O", U"ö");
    revised = replace_all(std::move(revised), U"U", U"ü");
    revised = replace_all(std::move(revised), U"e", U"é");
    revised = replace_all(std::move(revised), U"A", U"e");
    revised = replace_all(std::move(revised), U"G", U"ğ");
    revised = replace_all(std::move(revised), U"w", U"v");
    return revise_cts(revised, false);
}

std::u32string umsc::XJUS2UAS_impl(const std::u32string& text) {
    std::u32string revised = text;
    revised = replace_all(std::move(revised), U"v", U"\u0626");
    revised = replace_all(std::move(revised), U"c", U"ç");
    revised = replace_all(std::move(revised), U"j", U"c");
    revised = replace_all(std::move(revised), U"J", U"j");
    revised = replace_all(std::move(revised), U"x", U"ş");
    revised = replace_all(std::move(revised), U"H", U"x");
    revised = replace_all(std::move(revised), U"N", U"ñ");
    revised = replace_all(std::move(revised), U"O", U"ö");
    revised = replace_all(std::move(revised), U"U", U"ü");
    revised = replace_all(std::move(revised), U"e", U"é");
    revised = replace_all(std::move(revised), U"A", U"e");
    revised = replace_all(std::move(revised), U"G", U"ğ");
    revised = replace_all(std::move(revised), U"w", U"v");
    return CTS2UAS_impl(revise_cts(revised, false));
}

std::u32string umsc::UZLS2CTS_impl(const std::u32string& text) {
    std::u32string revised = text;
    revised = replace_all(std::move(revised), U"ch", U"ç");
    revised = replace_all(std::move(revised), U"sh", U"ş");
    revised = replace_all(std::move(revised), U"s'h", U"sh");
    revised = replace_all(std::move(revised), U"ng", U"ñ");
    revised = replace_all(std::move(revised), U"n'g", U"ng");
    revised = replace_all(std::move(revised), U"g‘", U"ğ");
    revised = replace_all(std::move(revised), U"o‘", U"ö");
    revised = replace_all(std::move(revised), U"u‘", U"ü");
    revised = replace_all(std::move(revised), U"e", U"é");
    revised = replace_all(std::move(revised), U"a", U"e");
    revised = replace_all(std::move(revised), U"o", U"a");
    revised = replace_all(std::move(revised), U"j", U"c");
    return revise_cts(revised, false);
}

std::u32string umsc::CTS2UAS_impl(const std::u32string& text) {
    std::u32string revised = add_hamza_before_vowels(text);
    revised = replace_via_table(std::move(revised), cts_group1(), uas_group1());
    revised = replace_all(std::move(revised), U"'", U"");
    return revise_uas(revised);
}

std::u32string umsc::CTS2ULS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_all(std::move(revised), U"ng", U"n'g");
    revised = replace_all(std::move(revised), U"sh", U"s'h");
    revised = replace_all(std::move(revised), U"ch", U"c'h");
    revised = replace_all(std::move(revised), U"zh", U"z'h");
    revised = replace_all(std::move(revised), U"gh", U"g'h");
    revised = replace_all(std::move(revised), U"ng", U"n'g");
    revised = replace_all(std::move(revised), U"nğ", U"n'gh");
    revised = replace_all(std::move(revised), U"ñ", U"ng");
    revised = replace_all(std::move(revised), U"j", U"zh");
    revised = replace_all(std::move(revised), U"c", U"j");
    revised = replace_all(std::move(revised), U"ç", U"ch");
    revised = replace_all(std::move(revised), U"ş", U"sh");
    revised = replace_all(std::move(revised), U"ğ", U"gh");
    revised = replace_all(std::move(revised), U"v", U"w");
    return revised;
}

std::u32string umsc::CTS2UYS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_all(std::move(revised), U"ng", U"n'g");
    revised = replace_all(std::move(revised), U"e", U"ə");
    revised = replace_all(std::move(revised), U"j", U"ⱬ");
    revised = replace_all(std::move(revised), U"c", U"j");
    revised = replace_all(std::move(revised), U"q", U"ⱪ");
    revised = replace_all(std::move(revised), U"ç", U"q");
    revised = replace_all(std::move(revised), U"h", U"ⱨ");
    revised = replace_all(std::move(revised), U"x", U"h");
    revised = replace_all(std::move(revised), U"ş", U"x");
    revised = replace_all(std::move(revised), U"ñ", U"ng");
    revised = replace_all(std::move(revised), U"ö", U"ø");
    revised = replace_all(std::move(revised), U"v", U"w");
    revised = replace_all(std::move(revised), U"é", U"e");
    revised = replace_all(std::move(revised), U"ğ", U"ƣ");
    return revised;
}

std::u32string umsc::CTS2IPA_impl(const std::u32string& text) {
    std::vector<std::u32string> cts = cts_group1();
    std::vector<std::u32string> ipa = ipa_group1();

    const auto position = std::find(cts.begin(), cts.end(), U"y");
    if (position != cts.end()) {
        const auto index = static_cast<std::size_t>(std::distance(cts.begin(), position));
        cts.erase(cts.begin() + static_cast<std::ptrdiff_t>(index));
        ipa.erase(ipa.begin() + static_cast<std::ptrdiff_t>(index));
    }

    std::u32string revised = replace_via_table(text, cts, ipa);
    revised = replace_all(std::move(revised), U"ü", U"y");
    return revised;
}

std::u32string umsc::CTS2UZLS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_all(std::move(revised), U"a", U"o");
    revised = replace_all(std::move(revised), U"e", U"a");
    revised = replace_all(std::move(revised), U"c", U"j");
    revised = replace_all(std::move(revised), U"q", U"q");
    revised = replace_all(std::move(revised), U"ç", U"ch");
    revised = replace_all(std::move(revised), U"ş", U"sh");
    revised = replace_all(std::move(revised), U"ñ", U"ng");
    revised = replace_all(std::move(revised), U"ö", U"o‘");
    revised = replace_all(std::move(revised), U"ü", U"u‘");
    revised = replace_all(std::move(revised), U"é", U"e");
    revised = replace_all(std::move(revised), U"ğ", U"g‘");
    return revised;
}

std::u32string umsc::CTS2XJUS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_all(std::move(revised), U"e", U"A");
    revised = replace_all(std::move(revised), U"x", U"H");
    revised = replace_all(std::move(revised), U"j", U"J");
    revised = replace_all(std::move(revised), U"c", U"j");
    revised = replace_all(std::move(revised), U"ç", U"c");
    revised = replace_all(std::move(revised), U"ş", U"x");
    revised = replace_all(std::move(revised), U"ñ", U"N");
    revised = replace_all(std::move(revised), U"ö", U"O");
    revised = replace_all(std::move(revised), U"ü", U"U");
    revised = replace_all(std::move(revised), U"é", U"e");
    revised = replace_all(std::move(revised), U"ğ", U"G");
    revised = replace_all(std::move(revised), U"v", U"w");
    revised = add_xjus_vowels(revised);
    revised = replace_all(std::move(revised), U"'", U"");
    return revised;
}

std::u32string umsc::CTS2UCS_impl(const std::u32string& text) {
    std::u32string revised = to_lower_ascii(text);
    revised = replace_all(std::move(revised), U"ya", U"я");
    revised = replace_all(std::move(revised), U"yu", U"ю");
    return replace_via_table(std::move(revised), cts_group1(), ucs_group1());
}

std::u32string umsc::convert_u32(
    const std::u32string& text,
    const std::string& source_script,
    const std::string& target_script) {
    if (source_script == target_script) {
        return text;
    }

    if (source_script == "CTS") {
        if (target_script == "UAS") {
            return CTS2UAS_impl(text);
        }
        if (target_script == "ULS") {
            return CTS2ULS_impl(text);
        }
        if (target_script == "UYS") {
            return CTS2UYS_impl(text);
        }
        if (target_script == "IPA") {
            return CTS2IPA_impl(text);
        }
        if (target_script == "UZLS") {
            return CTS2UZLS_impl(text);
        }
        if (target_script == "XJUS") {
            return CTS2XJUS_impl(text);
        }
        if (target_script == "UCS") {
            return CTS2UCS_impl(text);
        }
        throw std::invalid_argument("Conversion from CTS to " + target_script + " not supported");
    }

    if (source_script == "UAS") {
        if (target_script == "CTS") {
            return UAS2CTS_impl(text, false);
        }
        if (target_script == "ULS") {
            return CTS2ULS_impl(UAS2CTS_impl(text, true));
        }
        if (target_script == "UCS") {
            return CTS2UCS_impl(UAS2CTS_impl(text, true));
        }
        if (target_script == "UYS") {
            return CTS2UYS_impl(UAS2CTS_impl(text, true));
        }
        if (target_script == "UZLS") {
            return CTS2UZLS_impl(UAS2CTS_impl(text, true));
        }
    }

    if (source_script == "ULS") {
        if (target_script == "CTS") {
            return ULS2CTS_impl(text);
        }
        if (target_script == "UAS") {
            return CTS2UAS_impl(ULS2CTS_impl(text));
        }
        if (target_script == "UCS") {
            return CTS2UCS_impl(ULS2CTS_impl(text));
        }
        if (target_script == "UYS") {
            return CTS2UYS_impl(ULS2CTS_impl(text));
        }
    }

    if (source_script == "UYS") {
        if (target_script == "CTS") {
            return UYS2CTS_impl(text);
        }
        if (target_script == "UAS") {
            return CTS2UAS_impl(UYS2CTS_impl(text));
        }
        if (target_script == "ULS") {
            return CTS2ULS_impl(UYS2CTS_impl(text));
        }
        if (target_script == "UCS") {
            return CTS2UCS_impl(UYS2CTS_impl(text));
        }
    }

    if (source_script == "UCS") {
        if (target_script == "CTS") {
            return UCS2CTS_impl(text);
        }
        if (target_script == "UAS") {
            return CTS2UAS_impl(UCS2CTS_impl(text));
        }
        if (target_script == "ULS") {
            return CTS2ULS_impl(UCS2CTS_impl(text));
        }
        if (target_script == "UYS") {
            return CTS2UYS_impl(UCS2CTS_impl(text));
        }
    }

    if (source_script == "XJUS") {
        if (target_script == "CTS") {
            return XJUS2CTS_impl(text);
        }
        if (target_script == "UAS") {
            return XJUS2UAS_impl(text);
        }
    }

    if (source_script == "UZLS") {
        if (target_script == "CTS") {
            return UZLS2CTS_impl(text);
        }
    }

    throw std::invalid_argument(
        "Conversion from " + source_script + " to " + target_script + " not supported");
}
