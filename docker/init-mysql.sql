-- Runs once when the MySQL container is first created.
-- Creates the 'meos' application user with full privileges
-- (matching the MeOS convention of a passwordless local user).

CREATE USER IF NOT EXISTS 'meos'@'%' IDENTIFIED BY '';
GRANT ALL PRIVILEGES ON *.* TO 'meos'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
