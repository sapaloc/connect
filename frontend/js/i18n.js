/* CONNECT i18n EN/VI — expanded coverage */
(function(g){
const D={
en:{signin:'Sign in',signout:'Sign out',role:'Active role & scope',email:'Email',password:'Password',go:'Enter',invite:'Invitation',reset:'Password reset',support:'Platform support access (reason required)',supportPh:'Why are you entering tenant scope?',enter_support:'Enter with support banner',lang:'Language',home:'Home',partners:'Partners',locations:'Locations',referrers:'Referrers',budget:'Budget',media:'Links & Media',cards:'NFC Cards',site:'Microsite',content:'Site Content',vouchers:'Vouchers',counter:'Counter',txns:'Transactions',payout:'Payout',settle:'Settlements',reports:'Reports',audit:'Audit',settings:'Settings',approve:'Approve',reject:'Reject',activate:'Activate',pause:'Pause',resume:'Resume',end:'End',save:'Save',export_csv:'Export CSV',attention:'Attention queue',search:'Search…',all:'All',valid:'Valid',used:'Used',expired:'Expired',invalid:'Blocked / invalid',offline:'Connectivity failure — online required',confirm_redeem:'Confirm redemption',validate:'Validate',select_items:'Select open items',record_payment:'Record transfer-completed',new_voucher:'Create another voucher',remaining:'remaining',contact_zalo:'Zalo',contact_wa:'WhatsApp'},
vi:{signin:'Đăng nhập',signout:'Đăng xuất',role:'Vai trò & phạm vi',email:'Email',password:'Mật khẩu',go:'Vào',invite:'Lời mời',reset:'Đặt lại mật khẩu',support:'Truy cập hỗ trợ Platform (cần lý do)',supportPh:'Vì sao vào phạm vi tenant?',enter_support:'Vào với banner hỗ trợ',lang:'Ngôn ngữ',home:'Tổng quan',partners:'Đối tác',locations:'Địa điểm',referrers:'Người giới thiệu',budget:'Ngân sách',media:'Link & Media',cards:'Thẻ NFC',site:'Microsite',content:'Nội dung',vouchers:'Voucher',counter:'Thu ngân',txns:'Giao dịch',payout:'Chi trả',settle:'Quyết toán',reports:'Báo cáo',audit:'Nhật ký',settings:'Cài đặt',approve:'Duyệt',reject:'Từ chối',activate:'Kích hoạt',pause:'Tạm dừng',resume:'Tiếp tục',end:'Kết thúc',save:'Lưu',export_csv:'Xuất CSV',attention:'Việc cần xử lý',search:'Tìm kiếm…',all:'Tất cả',valid:'Hợp lệ',used:'Đã dùng',expired:'Hết hạn',invalid:'Bị chặn / không hợp lệ',offline:'Mất kết nối — cần mạng',confirm_redeem:'Xác nhận sử dụng',validate:'Kiểm tra',select_items:'Chọn mục chưa quyết toán',record_payment:'Ghi nhận đã chuyển',new_voucher:'Tạo thêm voucher',remaining:'còn lại',contact_zalo:'Zalo',contact_wa:'WhatsApp'}};
function lang(DB){
  // priority: 1 stored anon → 2 browser → 3 EN (spec §10)
  const stored=localStorage.getItem('connect_lang')||(DB.settings&&DB.settings.lang);
  if(stored==='en'||stored==='vi') return stored;
  const b=(navigator.language||'en').toLowerCase();
  return b.startsWith('vi')?'vi':'en';
}
function t(db,k){ const l=lang(db); return (D[l]&&D[l][k])||D.en[k]||k; }
function setLang(l){ localStorage.setItem('connect_lang',l); }
g.ConnectI18N={D,t,lang,setLang};
})(window);
