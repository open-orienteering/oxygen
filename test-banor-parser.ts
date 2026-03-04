import * as fs from 'fs';
import { parseOCDCourseData } from './packages/api/src/ocd-course-parser';

const fileData = fs.readFileSync('/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd');
const parsed = parseOCDCourseData(fileData);

console.log(`Courses found: ${parsed.courses.length}`);
parsed.courses.slice(0, 3).forEach(c => {
    console.log(`Course ${c.name}:`);
    console.log(`  Starts with: ${c.controls[0]?.controlId} ${JSON.stringify(c.controls[0]?.mapPosition)}`);
    console.log(`  Ends with: ${c.controls[c.controls.length - 1]?.controlId} ${JSON.stringify(c.controls[c.controls.length - 1]?.mapPosition)}`);
});

const s = parsed.controls.find(c => c.type === 'Start');
console.log(`Global Start: ${s?.id} ${s?.mapX},${s?.mapY}`);
const f = parsed.controls.find(c => c.type === 'Finish');
console.log(`Global Finish: ${f?.id} ${f?.mapX},${f?.mapY}`);
