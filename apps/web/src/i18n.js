const messages = {
  vi: {
    title: 'Đăng nhập',
    subtitle: 'Dành cho Spa, nhân viên quầy và partner.',
    email: 'Email',
    password: 'Mật khẩu',
    submit: 'Đăng nhập',
    signInSoon: 'Chức năng đăng nhập sẽ có trong bản cập nhật tiếp theo.',
    statusOk: 'Hệ thống hoạt động',
    statusDown: 'Không kết nối được hệ thống',
  },
  en: {
    title: 'Sign in',
    subtitle: 'For the Spa, counter staff and partners.',
    email: 'Email',
    password: 'Password',
    submit: 'Sign in',
    signInSoon: 'Sign-in arrives in the next update.',
    statusOk: 'System online',
    statusDown: 'Cannot reach the system',
  },
};

const STORAGE_KEY = 'connect.lang';

export function getLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved in messages ? saved : 'vi';
}

/** @param {string} lang */
export function setLang(lang) {
  localStorage.setItem(STORAGE_KEY, lang);
}

/** @param {string} key */
export function t(key) {
  return messages[getLang()][key] ?? key;
}
