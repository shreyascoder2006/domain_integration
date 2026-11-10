// Gateways take integer amounts in the currency's smallest unit (USD cents,
// INR paise, JPY yen...). Exponents per Razorpay's supported-currency table.
const ZERO = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'OMR', 'TND']);

export const exponent = (currency) => {
  const c = String(currency).toUpperCase();
  return ZERO.has(c) ? 0 : THREE.has(c) ? 3 : 2;
};

/** 49.91 USD -> 4991. Rounds to a whole minor unit (three-decimal currencies: last digit 0). */
export function toMinor(amount, currency) {
  const e = exponent(currency);
  const minor = Math.round(Number(amount) * 10 ** e);
  return e === 3 ? Math.round(minor / 10) * 10 : minor;
}
