import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);

// Search for any form of c95 and c96 next to each other
let i = 0;
while (i < fileData.length) {
    let found = fileData.indexOf(Buffer.from("c95"), i);
    if (found === -1) break;

    let txtEnd = found;
    while (txtEnd < fileData.length && fileData[txtEnd] !== 0) txtEnd++;
    let txtStart = found;
    while (txtStart > 0 && fileData[txtStart - 1] !== 0) txtStart--;

    const context = fileData.slice(txtStart, txtEnd).toString("utf8");
    console.log("Found c95 in string:", context.replace(/\n|\r|\t/g, " | "));
    i = txtEnd + 1;
}

