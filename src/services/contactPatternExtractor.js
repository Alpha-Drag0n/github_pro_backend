/**
 * Contact Pattern Extractor
 * Extracts email, phone, discord, telegram, whatsapp, and social profiles from text
 * Uses comprehensive regex patterns to handle multiple variations
 */

class ContactPatternExtractor {
  /**
   * Extract all contact information from text
   * @param {string} text - Text to extract from
   * @returns {object} Extracted contact information with confidence scores
   */
  static extractContactInfo(text) {
    if (!text || typeof text !== 'string') {
      return this.getEmptyResult();
    }

    const result = {
      emails: [],
      phones: [],
      discord: [],
      telegram: [],
      whatsapp: [],
    };

    // Extract each contact type
    result.emails = this.extractEmails(text);
    result.phones = this.extractPhones(text);
    result.discord = this.extractDiscord(text);
    result.telegram = this.extractTelegram(text);
    result.whatsapp = this.extractWhatsApp(text);

    // Remove duplicates
    result.emails = [...new Set(result.emails)];
    result.phones = [...new Set(result.phones)];
    result.discord = [...new Set(result.discord)];
    result.telegram = [...new Set(result.telegram)];
    result.whatsapp = [...new Set(result.whatsapp)];

    return result;
  }

  /**
   * Extract social profiles from text
   * @param {string} text - Text to extract from
   * @returns {object} Extracted social profiles
   */
  static extractSocialProfiles(text) {
    if (!text || typeof text !== 'string') {
      return this.getEmptySocialProfiles();
    }

    return {
      linkedin: this.extractLinkedIn(text),
      facebook: this.extractFacebook(text),
      x: this.extractX(text),
      youtube: this.extractYouTube(text),
      instagram: this.extractInstagram(text),
      tiktok: this.extractTikTok(text),
    };
  }

  /**
   * Extract emails
   * Pattern: standard email regex
   */
  static extractEmails(text) {
    // Standard email pattern
    const emailRegex = /[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(emailRegex) || [];
    
    // Filter out common false positives
    return matches.filter(email => {
      const invalidPatterns = [
        /^\./, // starts with dot
        /\.$/, // ends with dot
        /\.\./,  // double dots
        /^-/, // starts with dash
        /@-/, // @ followed by dash
      ];
      return !invalidPatterns.some(pattern => pattern.test(email));
    });
  }

  /**
   * Extract phone numbers in multiple formats
   * Handles: +1 234 567 8900, +1-234-567-8900, +1 (234) 567-8900, (234) 567-8900, 234-567-8900, etc.
   * International formats with country codes
   */
  static extractPhones(text) {
    const phones = [];

    // Pattern 1: International format with + and various separators
    // +1 234 567 8900, +1-234-567-8900, +1 (234) 567-8900, etc.
    const pattern1 = /\+\d{1,3}\s?[-.\s]?\(?(\d{2,4})\)?[-.\s]?(\d{2,4})[-.\s]?(\d{2,4})[-.\s]?(\d{2,4})?/g;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      const phone = this.normalizePhone(match[0]);
      if (this.isValidPhone(phone)) {
        phones.push(phone);
      }
    }

    // Pattern 2: US/Canada format starting with 1 (optional +)
    // 1 234 567 8900, 1-234-567-8900, (234) 567-8900, 234-567-8900
    const pattern2 = /(?:\+?1\s?)?[-.\s]?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g;
    while ((match = pattern2.exec(text)) !== null) {
      const phone = this.normalizePhone(match[0]);
      // Avoid duplicates
      if (this.isValidPhone(phone) && !phones.some(p => this.normalizePhone(p) === phone)) {
        phones.push(phone);
      }
    }

    // Pattern 3: Format without country code for shorter numbers
    // 1234567890 (10 digits without separators)
    const pattern3 = /(?:^|[^\d+])(\d{10})(?:[^\d]|$)/g;
    while ((match = pattern3.exec(text)) !== null) {
      const phone = match[1];
      if (this.isValidPhone(phone) && !phones.some(p => this.normalizePhone(p) === phone)) {
        phones.push(phone);
      }
    }

    return phones;
  }

  /**
   * Extract WhatsApp numbers
   * Context: whatsapp:, wa:, contact on whatsapp, msg on whatsapp, etc.
   */
  static extractWhatsApp(text) {
    const whatsappNumbers = [];

    // Pattern 1: Explicit whatsapp/wa prefix with various separators
    // whatsapp: +1 234 567 8900, wa: +1-234-567-8900, whatsapp +1 (234) 567-8900
    const pattern1 = /(?:whatsapp|wa|msg|message|contact)[:\s]+[\s]?([\+]?\d[\d\s.\-()]*\d)/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      const phone = this.normalizePhone(match[1]);
      if (this.isValidPhone(phone) && !whatsappNumbers.includes(phone)) {
        whatsappNumbers.push(phone);
      }
    }

    // Pattern 2: WhatsApp links
    // wa.me/1234567890, whatsapp.com/..., api.whatsapp.com/...
    const pattern2 = /(?:wa\.me|whatsapp\.com|api\.whatsapp\.com)[\/?](\+?\d[\d]*)/gi;
    while ((match = pattern2.exec(text)) !== null) {
      const phone = this.normalizePhone(match[1]);
      if (this.isValidPhone(phone) && !whatsappNumbers.includes(phone)) {
        whatsappNumbers.push(phone);
      }
    }

    return whatsappNumbers;
  }

  /**
   * Extract Discord handles and usernames
   * Patterns: discord.gg/xyz, @username#1234, discord: username, username#0000
   */
  static extractDiscord(text) {
    const discordHandles = [];

    // Pattern 1: Discord server/invite links
    // discord.gg/xyz123, discordapp.com/invite/xyz123
    const pattern1 = /(?:discord\.gg|discordapp\.com\/invite|discord\.com\/invite)\/([a-zA-Z0-9]{2,})/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      discordHandles.push(match[1]);
    }

    // Pattern 2: Discord mentions/handles
    // @username#1234, username#0000, @username
    const pattern2 = /@?([a-zA-Z0-9_.-]{2,32})#(\d{4})/g;
    while ((match = pattern2.exec(text)) !== null) {
      discordHandles.push(`${match[1]}#${match[2]}`);
    }

    // Pattern 3: Discord prefix
    // discord: username, discord username, dm: username
    const pattern3 = /(?:discord|dm|discord\s*user)[:\s]+[@]?([a-zA-Z0-9_.-]{2,32})/gi;
    while ((match = pattern3.exec(text)) !== null) {
      if (!match[1].includes('@') && match[1].length >= 2) {
        discordHandles.push(match[1]);
      }
    }

    return [...new Set(discordHandles)];
  }

  /**
   * Extract Telegram usernames
   * Patterns: @username, t.me/username, telegram: username
   */
  static extractTelegram(text) {
    const telegramHandles = [];

    // Pattern 1: Telegram links
    // t.me/username, telegram.me/username, telegram.dog/username
    const pattern1 = /(?:t\.me|telegram\.me|telegram\.dog)\/(@?[a-zA-Z0-9_]{5,32})/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      telegramHandles.push(match[1].replace(/^@/, ''));
    }

    // Pattern 2: @username format
    // @username (5-32 characters)
    const pattern2 = /@([a-zA-Z0-9_]{5,32})/g;
    while ((match = pattern2.exec(text)) !== null) {
      const handle = match[1];
      // Filter out common false positives like @mentions in regular text
      if (this.isTelegramHandle(handle)) {
        telegramHandles.push(handle);
      }
    }

    // Pattern 3: Telegram prefix
    // telegram: username, tg: username
    const pattern3 = /(?:telegram|tg)[:\s]+[@]?([a-zA-Z0-9_]{5,32})/gi;
    while ((match = pattern3.exec(text)) !== null) {
      telegramHandles.push(match[1].replace(/^@/, ''));
    }

    return [...new Set(telegramHandles)];
  }

  /**
   * Extract LinkedIn profiles
   */
  static extractLinkedIn(text) {
    const linkedinProfiles = [];

    // Pattern 1: LinkedIn URLs
    // linkedin.com/in/username or linkedin.com/company/companyname
    const pattern1 = /https?:\/\/(www\.)?linkedin\.com\/(in|company)\/([a-zA-Z0-9_-]+)/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      linkedinProfiles.push({
        url: match[0],
        handle: match[3],
      });
    }

    // Pattern 2: LinkedIn mentions without protocol
    // linkedin.com/in/username
    const pattern2 = /(?:linkedin\.com)\/(?:in|company)\/([a-zA-Z0-9_-]+)/gi;
    while ((match = pattern2.exec(text)) !== null) {
      const handle = match[1];
      if (!linkedinProfiles.some(p => p.handle === handle)) {
        linkedinProfiles.push({
          url: `https://linkedin.com/in/${handle}`,
          handle: handle,
        });
      }
    }

    return linkedinProfiles;
  }

  /**
   * Extract Facebook profiles
   */
  static extractFacebook(text) {
    const facebookProfiles = [];

    // Pattern 1: Facebook URLs
    // facebook.com/username or fb.com/username
    const pattern1 = /https?:\/\/(www\.)?(facebook\.com|fb\.com)\/([a-zA-Z0-9._-]+)/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      facebookProfiles.push({
        url: match[0],
        handle: match[3],
      });
    }

    // Pattern 2: Facebook mentions without protocol
    const pattern2 = /(?:facebook\.com|fb\.com)\/([a-zA-Z0-9._-]+)/gi;
    while ((match = pattern2.exec(text)) !== null) {
      const handle = match[1];
      if (!facebookProfiles.some(p => p.handle === handle)) {
        facebookProfiles.push({
          url: `https://facebook.com/${handle}`,
          handle: handle,
        });
      }
    }

    return facebookProfiles;
  }

  /**
   * Extract X (Twitter) profiles
   */
  static extractX(text) {
    const xProfiles = [];

    // Pattern 1: X/Twitter URLs (both x.com and twitter.com)
    const pattern1 = /https?:\/\/(www\.)?(x\.com|twitter\.com)\/([a-zA-Z0-9_]+)/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      xProfiles.push({
        url: match[0],
        handle: match[3],
      });
    }

    // Pattern 2: X/Twitter mentions without protocol
    const pattern2 = /(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)/gi;
    while ((match = pattern2.exec(text)) !== null) {
      const handle = match[1];
      if (!xProfiles.some(p => p.handle === handle)) {
        xProfiles.push({
          url: `https://x.com/${handle}`,
          handle: handle,
        });
      }
    }

    // Pattern 3: @handle mentions (Twitter style)
    // @username but not email-like
    const pattern3 = /(?:^|\s)@([a-zA-Z0-9_]{1,15})(?:\s|$|[^\w@.])/g;
    while ((match = pattern3.exec(text)) !== null) {
      const handle = match[1];
      if (!xProfiles.some(p => p.handle === handle) && !handle.includes('.')) {
        xProfiles.push({
          url: `https://x.com/${handle}`,
          handle: handle,
        });
      }
    }

    return xProfiles;
  }

  /**
   * Extract YouTube channels
   */
  static extractYouTube(text) {
    const youtubeChannels = [];

    // Pattern 1: YouTube channel URLs
    // youtube.com/c/channelname or youtube.com/@channelname or youtube.com/user/username
    const pattern1 = /https?:\/\/(www\.)?youtube\.com\/(c|@|user)\/([a-zA-Z0-9_-]+)/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      youtubeChannels.push({
        url: match[0],
        handle: match[3],
      });
    }

    // Pattern 2: YouTube mentions without protocol
    const pattern2 = /(?:youtube\.com)\/(c|@|user)\/([a-zA-Z0-9_-]+)/gi;
    while ((match = pattern2.exec(text)) !== null) {
      const type = match[1];
      const handle = match[2];
      if (!youtubeChannels.some(p => p.handle === handle)) {
        youtubeChannels.push({
          url: `https://youtube.com/${type}/${handle}`,
          handle: handle,
        });
      }
    }

    return youtubeChannels;
  }

  /**
   * Extract Instagram profiles
   */
  static extractInstagram(text) {
    const instagramProfiles = [];

    // Pattern 1: Instagram URLs
    const pattern1 = /https?:\/\/(www\.)?instagram\.com\/([a-zA-Z0-9._-]+)/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      const handle = match[2];
      if (handle !== 'p' && handle !== 'explore') {
        instagramProfiles.push({
          url: match[0],
          handle: handle,
        });
      }
    }

    // Pattern 2: Instagram mentions without protocol
    const pattern2 = /(?:instagram\.com)\/([a-zA-Z0-9._-]+)/gi;
    while ((match = pattern2.exec(text)) !== null) {
      const handle = match[1];
      if (handle !== 'p' && handle !== 'explore' && !instagramProfiles.some(p => p.handle === handle)) {
        instagramProfiles.push({
          url: `https://instagram.com/${handle}`,
          handle: handle,
        });
      }
    }

    return instagramProfiles;
  }

  /**
   * Extract TikTok profiles
   */
  static extractTikTok(text) {
    const tiktokProfiles = [];

    // Pattern 1: TikTok URLs
    const pattern1 = /https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com)\/@?([a-zA-Z0-9._-]+)/gi;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      const handle = match[3];
      if (handle && handle !== 'discover' && handle !== 'explore') {
        tiktokProfiles.push({
          url: match[0],
          handle: handle,
        });
      }
    }

    // Pattern 2: TikTok mentions without protocol
    const pattern2 = /(?:tiktok\.com)\/@?([a-zA-Z0-9._-]+)/gi;
    while ((match = pattern2.exec(text)) !== null) {
      const handle = match[1];
      if (handle && !tiktokProfiles.some(p => p.handle === handle)) {
        tiktokProfiles.push({
          url: `https://tiktok.com/@${handle}`,
          handle: handle,
        });
      }
    }

    return tiktokProfiles;
  }

  /**
   * Normalize phone number to consistent format
   * Removes spaces, dashes, parentheses, keeps only digits and +
   */
  static normalizePhone(phone) {
    if (!phone) return '';
    return phone.replace(/[\s\-().]/g, '').trim();
  }

  /**
   * Validate if phone number looks reasonable
   */
  static isValidPhone(phone) {
    const normalized = this.normalizePhone(phone);
    
    // Must have at least 7 digits (minimum for valid phone)
    const digitCount = (normalized.match(/\d/g) || []).length;
    
    // Must be 7-20 digits (international variations)
    return digitCount >= 7 && digitCount <= 20;
  }

  /**
   * Check if handle is likely a Telegram handle (not just random @mention)
   */
  static isTelegramHandle(handle) {
    // Telegram handles are 5-32 characters, alphanumeric + underscore
    // Often found with context like "t.me/", "telegram:", etc.
    return /^[a-zA-Z0-9_]{5,32}$/.test(handle);
  }

  /**
   * Build contact + social data in the exact shape the User schema expects, from one or
   * more labelled text sources (e.g. bio, README, blog). Maps the flat extractor output
   * to the schema's field names so values are NOT stripped by Mongoose strict mode:
   *   contactInfo.emails    -> { email, sources, confidence }
   *   contactInfo.phone     -> { number, sources, confidence }
   *   contactInfo.discord   -> { handle, sources }
   *   contactInfo.telegram  -> { username, sources }
   *   contactInfo.whatsapp  -> { phone, sources }
   *   socialProfiles.<net>  -> { url, handle, sources }
   *
   * @param {Array<{text: string, source: string}>} textSources
   * @returns {{ contactInfo: object, socialProfiles: object, summary: object }}
   */
  static buildUserContactData(textSources = []) {
    const emails = [];
    const phone = [];
    const discord = [];
    const telegram = [];
    const whatsapp = [];
    const social = { linkedin: [], facebook: [], x: [], youtube: [], instagram: [], tiktok: [] };

    const addValue = (arr, keyField, value, source, extra = {}) => {
      if (!value) return;
      const existing = arr.find((i) => i[keyField] === value);
      if (existing) {
        existing.sources = [...new Set([...(existing.sources || []), source])];
      } else {
        arr.push({ [keyField]: value, sources: [source], ...extra });
      }
    };

    const addSocial = (arr, item, source) => {
      if (!item || (!item.url && !item.handle)) return;
      const existing = arr.find(
        (i) => (item.url && i.url === item.url) || (item.handle && i.handle === item.handle)
      );
      if (existing) {
        existing.sources = [...new Set([...(existing.sources || []), source])];
      } else {
        arr.push({ url: item.url, handle: item.handle, sources: [source] });
      }
    };

    for (const entry of textSources) {
      const text = entry && entry.text;
      const source = (entry && entry.source) || 'profile';
      if (!text || typeof text !== 'string') continue;

      const contact = this.extractContactInfo(text);
      contact.emails.forEach((v) => addValue(emails, 'email', v, source, { confidence: 'medium' }));
      contact.phones.forEach((v) => addValue(phone, 'number', v, source, { confidence: 'medium' }));
      contact.discord.forEach((v) => addValue(discord, 'handle', v, source));
      contact.telegram.forEach((v) => addValue(telegram, 'username', v, source));
      contact.whatsapp.forEach((v) => addValue(whatsapp, 'phone', v, source));

      const profiles = this.extractSocialProfiles(text);
      Object.keys(social).forEach((net) => {
        (profiles[net] || []).forEach((item) => addSocial(social[net], item, source));
      });
    }

    const contactInfo = { emails, phone, discord, telegram, whatsapp };
    const summary = {
      emails: emails.length,
      phone: phone.length,
      discord: discord.length,
      telegram: telegram.length,
      whatsapp: whatsapp.length,
      social: Object.values(social).reduce((n, arr) => n + arr.length, 0),
    };

    return { contactInfo, socialProfiles: social, summary };
  }

  static getEmptyResult() {
    return {
      emails: [],
      phones: [],
      discord: [],
      telegram: [],
      whatsapp: [],
    };
  }

  static getEmptySocialProfiles() {
    return {
      linkedin: [],
      facebook: [],
      x: [],
      youtube: [],
      instagram: [],
      tiktok: [],
    };
  }
}

module.exports = ContactPatternExtractor;
