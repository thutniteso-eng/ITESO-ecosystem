import vi from '../locales/vi.json';
import en from '../locales/en.json';

const dictionaries: Record<string, any> = {
  vi,
  en,
};

export function getDictionary(locale: string = 'vi') {
  return dictionaries[locale] || dictionaries.vi;
}

export function t(pathStr: string, locale: string = 'vi'): string {
  const dict = getDictionary(locale);
  const keys = pathStr.split('.');
  let current: any = dict;

  for (const k of keys) {
    if (current && typeof current === 'object' && k in current) {
      current = current[k];
    } else {
      return pathStr; // fallback to key
    }
  }

  return typeof current === 'string' ? current : pathStr;
}
