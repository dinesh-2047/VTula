/**
 * Multilingual support (English + Hindi).
 *
 * The spec lists a bilingual interface as a requirement for field and business
 * users; nothing in the app was translated before. This is a plain dictionary
 * rather than a framework: it is client-safe, has no dependencies, and adding a
 * third language is a matter of adding one more key set.
 *
 * `t()` falls back to English and then to the key itself, so a missing
 * translation degrades to readable text instead of an empty string.
 *
 * Which surfaces are actually translated is tracked in `LocaleProvider`. This file
 * being complete is not the same as the product being bilingual — for a while it
 * was exactly that: a finished dictionary that only `/api/settings` imported, for
 * the names of the languages in a dropdown whose choice nothing honoured.
 */

export const LOCALES = ['en', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  hi: 'हिन्दी',
};

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Where the chosen locale is kept.
 *
 * A cookie rather than the session, for two reasons. Half the surfaces that most
 * need Hindi — the trust centre, the public report form — are used by citizens who
 * have no account and never will. And the signed-in preference lives in
 * `user.preferences.language`, which is only readable after a database round trip;
 * a cookie is readable by the shell on first paint, so the interface does not
 * flash English at a Hindi reader on every navigation.
 *
 * Not `httpOnly`: the switcher is a client component and has to be able to write
 * it. Nothing is authorised on the strength of this value — it selects strings.
 */
export const LOCALE_COOKIE = 'vtula_locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

type Dictionary = Record<string, string>;

const en = {
  // Brand & general
  'app.name': 'VTULA',
  'app.tagline': 'Legal Metrology verification and public trust platform',
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.submit': 'Submit',
  'common.search': 'Search',
  'common.filter': 'Filter',
  'common.all': 'All',
  'common.none': 'None',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.reason': 'Reason',
  'common.required': 'Required',
  'common.optional': 'Optional',
  'common.notRecorded': 'Not recorded',
  'common.download': 'Download',
  'common.print': 'Print',
  'common.retry': 'Try again',
  'common.language': 'Language',
  'common.home': 'Home',

  /*
   * Navigation labels are keyed to the wording each role actually sees, not to the
   * route. An owner's sidebar says "My Instruments" and an administrator's says
   * "All Instruments"; those are different sentences about the same register and a
   * single `nav.instruments` would have flattened the distinction that makes the
   * menu readable.
   */
  'nav.dashboard': 'Dashboard',
  'nav.instruments': 'Instruments',
  'nav.myInstruments': 'My Instruments',
  'nav.allInstruments': 'All Instruments',
  'nav.applications': 'Applications',
  'nav.allApplications': 'All Applications',
  'nav.certificates': 'Certificates',
  'nav.allCertificates': 'All Certificates',
  'nav.inspectionTasks': 'Inspection Tasks',
  'nav.labTasks': 'Lab Tasks',
  'nav.inspectionVisits': 'Inspection Visits',
  'nav.schedule': 'Schedule',
  'nav.inspectionSchedule': 'Inspection Schedule',
  'nav.compliance': 'Compliance Health',
  'nav.reports': 'Reports',
  'nav.reportsAnalytics': 'Reports & Analytics',
  'nav.users': 'User Management',
  'nav.gatc': 'GATC Centres',
  'nav.rules': 'Regulatory Rules',
  'nav.enforcement': 'Enforcement',
  'nav.complaints': 'Public Complaints',
  'nav.risk': 'Risk Findings',
  'nav.notifications': 'Notifications',
  'nav.profile': 'My Profile',
  'nav.preferences': 'Preferences',
  'nav.settings': 'Settings',
  'nav.verify': 'Verify a certificate',
  'nav.publicVerify': 'Public Verify',
  'nav.signOut': 'Sign Out',
  'nav.openMenu': 'Open the menu',
  'nav.closeMenu': 'Close the menu',
  'nav.searchLabel': 'Search the registers',
  'nav.searchPlaceholder': 'Serial, brand or model — or paste a VT-APP / VT-CERT number',
  'nav.clearSearch': 'Clear search',
  'nav.unreadCount': 'Notifications, {count} unread',
  'search.noteInspection': 'Inspection reports open from the task they belong to.',
  'search.noteSeal': 'Seal numbers are shown on the instrument they are fitted to.',

  // Language switcher
  'language.change': 'Change language',
  'language.current': 'Language: {name}',

  // Auth
  'auth.signIn': 'Sign in',
  'auth.signUp': 'Create an account',
  'auth.email': 'Email address',
  'auth.password': 'Password',
  'auth.phone': 'Mobile number',
  'auth.otp': 'One-time password',
  'auth.sendOtp': 'Send OTP',
  'auth.verifyOtp': 'Verify OTP',
  'auth.emailPassword': 'Email & password',
  'auth.phoneOtp': 'Mobile OTP',
  'auth.pendingApproval': 'Your account is awaiting approval by an administrator.',

  // Instruments
  'instrument.type': 'Instrument type',
  'instrument.brand': 'Make',
  'instrument.model': 'Model',
  'instrument.serialNo': 'Serial number',
  'instrument.capacity': 'Capacity',
  'instrument.accuracyClass': 'Accuracy class',
  'instrument.location': 'Installation address',
  'instrument.passport': 'Digital passport',
  'instrument.timeline': 'Lifecycle timeline',
  'instrument.lastVerified': 'Last verified',
  'instrument.nextDue': 'Next verification due',

  // Applications
  'application.no': 'Application number',
  'application.type': 'Verification type',
  'application.status': 'Status',
  'application.submitted': 'Submitted on',
  'application.fee': 'Statutory fee',
  'application.new': 'New application',
  'application.track': 'Track application',
  'application.query': 'Officer query',
  'application.respond': 'Respond',
  'application.decision': 'Decision',
  'application.justification': 'Justification',

  // Certificates
  'certificate.no': 'Certificate number',
  'certificate.issued': 'Issued on',
  'certificate.expires': 'Valid until',
  'certificate.issuedBy': 'Issuing officer',
  'certificate.status': 'Status',
  'certificate.verify': 'Verify authenticity',
  'certificate.scanQr': 'Scan the QR code to verify',

  // Verification / trust centre
  'verify.title': 'Certificate Trust Centre',
  'verify.subtitle': 'Check whether a verification certificate is genuine and currently valid. No account needed.',
  'verify.enterNumber': 'Enter the certificate number',
  'verify.genuine': 'This certificate is genuine and valid',
  'verify.expired': 'This certificate is genuine but has expired',
  'verify.suspended': 'This certificate is currently suspended',
  'verify.revoked': 'This certificate has been revoked',
  'verify.superseded': 'This certificate has been replaced by a newer one',
  'verify.notFound': 'No certificate was found with this number',
  'verify.integrityOk': 'Cryptographic integrity check passed',
  'verify.integrityFailed': 'Cryptographic integrity check failed',
  'verify.report': 'Report a suspicious certificate',

  /*
   * The trust centre's own copy. Split into whole sentences rather than fragments
   * so a translator is never asked to guess where a clause will land: the one place
   * a link sits mid-sentence is spelled out as three keys, because Hindi puts the
   * verb at the end and stitching "before + link + after" in English word order
   * would produce nonsense.
   */
  'verify.landing.title': 'Is this instrument legally verified?',
  'verify.landing.lead':
    'Every weighing and measuring instrument used in trade carries a verification sticker. Check its number here to see whether the certificate is current, who issued it, and what was tested. No account, no charge.',
  'verify.landing.waysTitle': 'Three ways to check',
  'verify.landing.scanTitle': "Scan the QR code with your phone's camera",
  'verify.landing.scanBody':
    'The code on the sticker is a link. Your normal camera app will open the result straight away — this is the quickest way, and it needs nothing installed.',
  'verify.landing.typeTitle': 'Type the certificate number',
  'verify.landing.typeBody':
    'Printed beneath the QR code, in the form {example}. Use the box above.',
  'verify.landing.noStickerTitle': 'No sticker at all?',
  'verify.landing.noStickerBefore':
    'An instrument used for trade without a current verification is itself an offence under the Legal Metrology Act, 2009. You can',
  'verify.landing.noStickerLink': 'report it using the serial number on the machine',
  'verify.landing.noStickerAfter':
    '— no account needed — or contact your district Legal Metrology office directly.',

  /*
   * The complaint call-out. Same before/link/after shape as the sticker line, and
   * for the same reason: Hindi puts the verb last, so a sentence stitched from two
   * English halves either side of a link reads as nonsense in it.
   */
  'verify.landing.complainTitle': 'Were you given less than you paid for?',
  'verify.landing.complainBefore':
    'If a shop short-measured you, or its machine carries no verification sticker at all, you can',
  'verify.landing.complainLink': 'file a complaint with photos or a video',
  'verify.landing.complainAfter':
    '— no account needed. You are given a reference number, and the shop is never told who complained.',
  'verify.footer': 'Legal Metrology Department · verification under the Legal Metrology Act, 2009',

  // Compliance
  'compliance.score': 'Compliance health score',
  'compliance.breakdown': 'How this score is calculated',
  'compliance.recommendations': 'What to do next',

  // Risk (advisory language matters: these are recommendations, not decisions)
  'risk.flags': 'Risk flags',
  'risk.advisory': 'Advisory only — an officer must confirm or dismiss each flag.',
  'risk.reasons': 'Why this was flagged',
  'risk.recommendedAction': 'Recommended action',
  'risk.confirm': 'Confirm flag',
  'risk.dismiss': 'Dismiss flag',
} satisfies Dictionary;

/**
 * Every key English defines, as a type.
 *
 * Two things follow from this, both of which the plain `Record<string, string>` on
 * both dictionaries used to allow. A Hindi set that is missing a key is now a
 * compile error rather than a silent English word in the middle of a Hindi
 * sentence. And a `t('nav.dashbaord')` typo is a compile error rather than the
 * literal string `nav.dashbaord` rendered into the sidebar.
 */
export type TranslationKey = keyof typeof en;

const hi: Record<TranslationKey, string> = {
  'app.name': 'वीटुला',
  'app.tagline': 'विधिक माप विज्ञान सत्यापन एवं सार्वजनिक विश्वास मंच',
  'common.loading': 'लोड हो रहा है…',
  'common.save': 'सहेजें',
  'common.cancel': 'रद्द करें',
  'common.submit': 'जमा करें',
  'common.search': 'खोजें',
  'common.filter': 'छाँटें',
  'common.all': 'सभी',
  'common.none': 'कोई नहीं',
  'common.back': 'पीछे',
  'common.next': 'आगे',
  'common.close': 'बंद करें',
  'common.confirm': 'पुष्टि करें',
  'common.reason': 'कारण',
  'common.required': 'आवश्यक',
  'common.optional': 'वैकल्पिक',
  'common.notRecorded': 'दर्ज नहीं',
  'common.download': 'डाउनलोड',
  'common.print': 'प्रिंट',
  'common.retry': 'पुनः प्रयास करें',
  'common.language': 'भाषा',
  'common.home': 'मुख्य पृष्ठ',

  'nav.dashboard': 'डैशबोर्ड',
  'nav.instruments': 'उपकरण',
  'nav.myInstruments': 'मेरे उपकरण',
  'nav.allInstruments': 'सभी उपकरण',
  'nav.applications': 'आवेदन',
  'nav.allApplications': 'सभी आवेदन',
  'nav.certificates': 'प्रमाणपत्र',
  'nav.allCertificates': 'सभी प्रमाणपत्र',
  'nav.inspectionTasks': 'निरीक्षण कार्य',
  'nav.labTasks': 'प्रयोगशाला कार्य',
  'nav.inspectionVisits': 'निरीक्षण दौरे',
  'nav.schedule': 'कार्यक्रम',
  'nav.inspectionSchedule': 'निरीक्षण कार्यक्रम',
  'nav.compliance': 'अनुपालन स्वास्थ्य',
  'nav.reports': 'रिपोर्ट',
  'nav.reportsAnalytics': 'रिपोर्ट एवं विश्लेषण',
  'nav.users': 'उपयोगकर्ता प्रबंधन',
  'nav.gatc': 'GATC केंद्र',
  'nav.rules': 'विनियामक नियम',
  'nav.enforcement': 'प्रवर्तन',
  'nav.complaints': 'जन शिकायतें',
  'nav.risk': 'जोखिम निष्कर्ष',
  'nav.notifications': 'सूचनाएँ',
  'nav.profile': 'मेरी प्रोफ़ाइल',
  'nav.preferences': 'प्राथमिकताएँ',
  'nav.settings': 'सेटिंग्स',
  'nav.verify': 'प्रमाणपत्र सत्यापित करें',
  'nav.publicVerify': 'सार्वजनिक सत्यापन',
  'nav.signOut': 'साइन आउट',
  'nav.openMenu': 'मेनू खोलें',
  'nav.closeMenu': 'मेनू बंद करें',
  'nav.searchLabel': 'रजिस्टर में खोजें',
  'nav.searchPlaceholder': 'क्रम संख्या, निर्माता या मॉडल — या VT-APP / VT-CERT संख्या चिपकाएँ',
  'nav.clearSearch': 'खोज हटाएँ',
  'nav.unreadCount': 'सूचनाएँ, {count} अपठित',
  'search.noteInspection': 'निरीक्षण रिपोर्ट उसी कार्य से खुलती है जिससे वह संबंधित है।',
  'search.noteSeal': 'सील संख्या उस उपकरण पर दर्शाई जाती है जिस पर वह लगी है।',

  'language.change': 'भाषा बदलें',
  'language.current': 'भाषा: {name}',

  'auth.signIn': 'साइन इन',
  'auth.signUp': 'खाता बनाएँ',
  'auth.email': 'ईमेल पता',
  'auth.password': 'पासवर्ड',
  'auth.phone': 'मोबाइल नंबर',
  'auth.otp': 'एकबारगी पासवर्ड (OTP)',
  'auth.sendOtp': 'OTP भेजें',
  'auth.verifyOtp': 'OTP सत्यापित करें',
  'auth.emailPassword': 'ईमेल और पासवर्ड',
  'auth.phoneOtp': 'मोबाइल OTP',
  'auth.pendingApproval': 'आपका खाता प्रशासक की स्वीकृति की प्रतीक्षा में है।',

  'instrument.type': 'उपकरण का प्रकार',
  'instrument.brand': 'निर्माता',
  'instrument.model': 'मॉडल',
  'instrument.serialNo': 'क्रम संख्या',
  'instrument.capacity': 'क्षमता',
  'instrument.accuracyClass': 'शुद्धता श्रेणी',
  'instrument.location': 'स्थापना का पता',
  'instrument.passport': 'डिजिटल पासपोर्ट',
  'instrument.timeline': 'जीवनचक्र समयरेखा',
  'instrument.lastVerified': 'अंतिम सत्यापन',
  'instrument.nextDue': 'अगला सत्यापन देय',

  'application.no': 'आवेदन संख्या',
  'application.type': 'सत्यापन प्रकार',
  'application.status': 'स्थिति',
  'application.submitted': 'जमा करने की तिथि',
  'application.fee': 'वैधानिक शुल्क',
  'application.new': 'नया आवेदन',
  'application.track': 'आवेदन ट्रैक करें',
  'application.query': 'अधिकारी की पूछताछ',
  'application.respond': 'उत्तर दें',
  'application.decision': 'निर्णय',
  'application.justification': 'कारण विवरण',

  'certificate.no': 'प्रमाणपत्र संख्या',
  'certificate.issued': 'जारी करने की तिथि',
  'certificate.expires': 'वैधता तिथि',
  'certificate.issuedBy': 'जारीकर्ता अधिकारी',
  'certificate.status': 'स्थिति',
  'certificate.verify': 'प्रामाणिकता जाँचें',
  'certificate.scanQr': 'सत्यापन हेतु QR कोड स्कैन करें',

  'verify.title': 'प्रमाणपत्र विश्वास केंद्र',
  'verify.subtitle': 'जाँचें कि कोई सत्यापन प्रमाणपत्र असली और वर्तमान में वैध है या नहीं। खाते की आवश्यकता नहीं।',
  'verify.enterNumber': 'प्रमाणपत्र संख्या दर्ज करें',
  'verify.genuine': 'यह प्रमाणपत्र असली और वैध है',
  'verify.expired': 'यह प्रमाणपत्र असली है परंतु समाप्त हो चुका है',
  'verify.suspended': 'यह प्रमाणपत्र वर्तमान में निलंबित है',
  'verify.revoked': 'यह प्रमाणपत्र निरस्त कर दिया गया है',
  'verify.superseded': 'इस प्रमाणपत्र के स्थान पर नया प्रमाणपत्र जारी हो चुका है',
  'verify.notFound': 'इस संख्या का कोई प्रमाणपत्र नहीं मिला',
  'verify.integrityOk': 'क्रिप्टोग्राफिक अखंडता जाँच सफल',
  'verify.integrityFailed': 'क्रिप्टोग्राफिक अखंडता जाँच विफल',
  'verify.report': 'संदिग्ध प्रमाणपत्र की सूचना दें',

  'verify.landing.title': 'क्या यह उपकरण विधिक रूप से सत्यापित है?',
  'verify.landing.lead':
    'व्यापार में प्रयुक्त प्रत्येक बाट एवं माप उपकरण पर सत्यापन स्टिकर लगा होता है। उसकी संख्या यहाँ दर्ज करके देखें कि प्रमाणपत्र वर्तमान में वैध है या नहीं, वह किसने जारी किया, और किन बातों की जाँच हुई। न खाता चाहिए, न कोई शुल्क।',
  'verify.landing.waysTitle': 'जाँच के तीन तरीके',
  'verify.landing.scanTitle': 'अपने फ़ोन के कैमरे से QR कोड स्कैन करें',
  'verify.landing.scanBody':
    'स्टिकर पर बना कोड एक लिंक है। आपका सामान्य कैमरा ऐप परिणाम सीधे खोल देगा — यह सबसे तेज़ तरीका है और इसके लिए कुछ भी इंस्टॉल करने की आवश्यकता नहीं।',
  'verify.landing.typeTitle': 'प्रमाणपत्र संख्या टाइप करें',
  'verify.landing.typeBody':
    'यह QR कोड के नीचे {example} के रूप में छपी होती है। ऊपर दिए बॉक्स का उपयोग करें।',
  'verify.landing.noStickerTitle': 'स्टिकर ही नहीं है?',
  'verify.landing.noStickerBefore':
    'वैध सत्यापन के बिना व्यापार में उपकरण का प्रयोग विधिक माप विज्ञान अधिनियम, 2009 के अंतर्गत स्वयं एक अपराध है। आप',
  'verify.landing.noStickerLink': 'मशीन पर लिखी क्रम संख्या से इसकी शिकायत दर्ज कर सकते हैं',
  'verify.landing.noStickerAfter':
    '— इसके लिए खाते की आवश्यकता नहीं — अथवा सीधे अपने ज़िले के विधिक माप विज्ञान कार्यालय से संपर्क करें।',

  'verify.landing.complainTitle': 'क्या आपको भुगतान से कम मात्रा मिली?',
  'verify.landing.complainBefore':
    'यदि किसी दुकान ने आपको कम तौलकर दिया है, अथवा उसकी मशीन पर कोई सत्यापन स्टिकर ही नहीं है, तो आप',
  'verify.landing.complainLink': 'फ़ोटो या वीडियो के साथ शिकायत दर्ज कर सकते हैं',
  'verify.landing.complainAfter':
    '— इसके लिए खाते की आवश्यकता नहीं। आपको एक संदर्भ संख्या दी जाती है, और दुकान को कभी नहीं बताया जाता कि शिकायत किसने की।',
  'verify.footer':
    'विधिक माप विज्ञान विभाग · विधिक माप विज्ञान अधिनियम, 2009 के अंतर्गत सत्यापन',

  'compliance.score': 'अनुपालन स्वास्थ्य स्कोर',
  'compliance.breakdown': 'यह स्कोर कैसे बना',
  'compliance.recommendations': 'आगे क्या करें',

  'risk.flags': 'जोखिम संकेत',
  'risk.advisory': 'केवल सलाहकारी — प्रत्येक संकेत की पुष्टि या खारिज अधिकारी द्वारा की जाती है।',
  'risk.reasons': 'यह क्यों चिह्नित हुआ',
  'risk.recommendedAction': 'सुझाई गई कार्रवाई',
  'risk.confirm': 'संकेत की पुष्टि करें',
  'risk.dismiss': 'संकेत खारिज करें',
};

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = { en, hi };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Looks up `key` in `locale`, falling back to English.
 * `vars` interpolates `{name}` placeholders.
 */
export function t(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>
): string {
  const raw = DICTIONARIES[locale][key] ?? en[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`
  );
}

/** Bound translator, so components can do `const tr = translator(locale)`. */
export function translator(locale: Locale) {
  return (key: TranslationKey, vars?: Record<string, string | number>) => t(locale, key, vars);
}

/** The shape `LocaleProvider` hands to a component. */
export type Translate = ReturnType<typeof translator>;

/** Locale-aware date formatting, used in notifications and certificates. */
export function formatDateLocalized(date: Date | string | undefined, locale: Locale): string {
  if (!date) return t(locale, 'common.notRecorded');
  return new Date(date).toLocaleDateString(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
