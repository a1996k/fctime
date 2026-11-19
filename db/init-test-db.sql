-- A second, empty database for the automated tests, which wipe it. Docker runs this once, as root,
-- when the MySQL container is first created. On your own server, run it as an admin user.
CREATE DATABASE IF NOT EXISTS fctime_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON fctime_test.* TO 'fctime'@'%';
