import * as fs from 'fs';
import { parseOCDCourseData } from './packages/api/src/ocd-course-parser.ts';
const f = fs.readFileSync('/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd');
const res = parseOCDCourseData(f);
console.log('Class assignments:', res.classAssignments);
