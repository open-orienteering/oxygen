import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);

const s = new Set<string>();

let i = 0;
while (i < fileData.length) {
    const chunkStart = fileData.indexOf(Buffer.from("1\tH\t"), i);
    if (chunkStart === -1) break;

    let start = chunkStart;
    while (start > 0 && fileData[start - 1] !== 0) start--;

    let nullIdx = chunkStart;
    while (nullIdx < fileData.length && fileData[nullIdx] !== 0) nullIdx++;

    const txt = fileData.slice(start, nullIdx).toString("utf8");
    if (!s.has(txt) && txt.startsWith("1\t")) {
        console.log("MATCH:", txt.replace(/\n|\r|\t/g, " | "));
        s.add(txt);
    }
    i = nullIdx + 1;
}
