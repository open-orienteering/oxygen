import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);

const s1 = fileData.indexOf(Buffer.from("<Control", "utf8"));
const s2 = fileData.indexOf(Buffer.from("<Control", "utf16le"));

console.log("utf8:", s1, "utf16:", s2);
