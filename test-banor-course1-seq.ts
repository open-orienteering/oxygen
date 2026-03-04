import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);

const searchStr = Buffer.from("c95\tc96\tc102", "utf8");
console.log("Index 95-96-102:", fileData.indexOf(searchStr));

const s2 = Buffer.from("c95\0\0\0c", "utf16le"); // maybe it's not tab separated?
console.log("UTF16 search:", fileData.indexOf(s2));
