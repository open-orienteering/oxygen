import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const stringParamIndexOff = fileData.readUInt32LE(20);

let blockOff = stringParamIndexOff;
const records = new Map<number, string[]>();

let seen = new Set<number>();
let count = 0;

while (blockOff > 0 && blockOff < fileData.length) {
    if (seen.has(blockOff)) break;
    seen.add(blockOff);

    // In OCAD 11/12, the first 4 bytes are nextBlock, followed by 256 * 20 byte entries! wait a minute.
    // wait... in OCAD 11/12, the string index block string index entry size is 20 bytes?! 
    // No, OCAD 11/12 documentation says:
    // StringIndexBlock format:
    // 0: next block (int32)
    // 4..256 records:
    // Ocad 11/12 StringIndexRec format is? Wait! Wait! Wait! 
    // Wait, let's look at `objIndexOffset` which is `12`.
    const nextBlock = fileData.readUInt32LE(blockOff);

    // if we don't know the exact struct size, just dump 32 bytes from the first string index block to see what it is
    if (count === 0) {
        console.log("First string block:", fileData.slice(blockOff, blockOff + 64).toString('hex'));
    }
    count++;

    blockOff = nextBlock;
}

console.log(`Saw ${count} blocks`);
