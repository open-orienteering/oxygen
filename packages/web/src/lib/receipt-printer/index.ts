export type { PrinterDriver, FinishReceiptData, FinishReceiptSplit } from "./types.js";
export { buildFinishReceipt } from "./escpos.js";
export { WebUsbPrinterDriver, isWebUsbSupported } from "./drivers/webusb.js";
