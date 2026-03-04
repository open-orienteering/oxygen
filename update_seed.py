
import re

def update_seed(filename):
    with open(filename, 'r') as f:
        content = f.read()

    # regex to find (Id, Name, CardNo, Club, Class, Course, StartNo, StartTime, ...
    # StartTime is the 8th field.
    
    def replace_start_time(match):
        values_str = match.group(1)
        # Split but carefully handling strings with commas
        # Actually, let's just use regex for the individual records
        records = re.findall(r'\([^)]+\)', values_str)
        new_records = []
        for rec in records:
            fields = rec.strip('()').split(',')
            # Fields: 0:Id, 1:Name, 2:CardNo, 3:Club, 4:Class, 5:Course, 6:StartNo, 7:StartTime, 8:FinishTime, 9:Status, ...
            if len(fields) > 9:
                status = fields[9].strip()
                start_time = fields[7].strip()
                if status == '0' and start_time != '0':
                    fields[7] = ' 1' # Set StartTime to 1
            new_records.append('(' + ','.join(fields) + ')')
        return 'INSERT INTO `oRunner` VALUES ' + ','.join(new_records)

    content = re.sub(r'INSERT INTO `oRunner` VALUES ( \(.+?\); )', replace_start_time, content, flags=re.DOTALL)
    
    # Also ensure ZeroTime is 0 for itest
    content = re.sub(r"INSERT INTO `oEvent` VALUES \(1,'My example tävling',.*?,(\d+),'itest'", 
                     lambda m: m.group(0).replace(m.group(1), '0'), content)

    with open(filename, 'w') as f:
        f.write(content)

update_seed('e2e/seed.sql')
