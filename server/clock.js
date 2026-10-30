const TZ = process.env.APP_TZ || 'Asia/Jakarta';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
export const ymd = (date = new Date()) => fmt.format(date); // YYYY-MM-DD di zona waktu bisnis
