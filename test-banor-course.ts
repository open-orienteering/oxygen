import * as fs from 'fs';
import { parseOCDCourseData } from './packages/api/src/ocd-course-parser';

const fileData = fs.readFileSync('/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd');
const parsed = parseOCDCourseData(fileData);

const c1 = parsed.courses.find(c => c.name === '1');
if (c1) {
    console.log(`Course 1 controls: ${c1.controls.map(c => c.controlId).join(', ')}`);
}

const c2 = parsed.courses.find(c => c.name === '2');
if (c2) {
    console.log(`Course 2 controls: ${c2.controls.map(c => c.controlId).join(', ')}`);
}

console.log("Global finish:", parsed.controls.find(c => c.type === 'Finish'));
