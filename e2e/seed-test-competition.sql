
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
DROP TABLE IF EXISTS `dbClub`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dbClub` (
  `Id` int NOT NULL,
  `Name` varchar(64) NOT NULL DEFAULT '',
  `District` int NOT NULL DEFAULT '0',
  `ShortName` varchar(17) NOT NULL DEFAULT '',
  `CareOf` varchar(63) NOT NULL DEFAULT '',
  `Street` varchar(83) NOT NULL DEFAULT '',
  `City` varchar(47) NOT NULL DEFAULT '',
  `State` varchar(47) NOT NULL DEFAULT '',
  `ZIP` varchar(23) NOT NULL DEFAULT '',
  `EMail` varchar(129) NOT NULL DEFAULT '',
  `Phone` varchar(65) NOT NULL DEFAULT '',
  `Nationality` varchar(7) NOT NULL DEFAULT '',
  `Country` varchar(47) NOT NULL DEFAULT '',
  `Type` varchar(41) NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `Invoice` varchar(3) NOT NULL DEFAULT '',
  `InvoiceNo` smallint unsigned NOT NULL DEFAULT '0',
  `StartGroup` int NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `dbRunner`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dbRunner` (
  `Name` varchar(64) NOT NULL DEFAULT '',
  `CardNo` int NOT NULL DEFAULT '0',
  `Club` int NOT NULL DEFAULT '0',
  `Nation` varchar(3) NOT NULL DEFAULT '',
  `Sex` varchar(1) NOT NULL DEFAULT '',
  `BirthYear` int NOT NULL DEFAULT '0',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oCard`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oCard` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `CardNo` int NOT NULL DEFAULT '0',
  `ReadId` int unsigned NOT NULL DEFAULT '0',
  `Voltage` int unsigned NOT NULL DEFAULT '0',
  `BDate` int NOT NULL DEFAULT '0',
  `Punches` varchar(3040) NOT NULL DEFAULT '',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oClass`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oClass` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) NOT NULL DEFAULT '',
  `Course` int NOT NULL DEFAULT '0',
  `MultiCourse` mediumtext NOT NULL,
  `LegMethod` varchar(1024) NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `LongName` varchar(65) NOT NULL DEFAULT '',
  `LowAge` tinyint unsigned NOT NULL DEFAULT '0',
  `HighAge` tinyint unsigned NOT NULL DEFAULT '0',
  `HasPool` tinyint unsigned NOT NULL DEFAULT '0',
  `AllowQuickEntry` tinyint unsigned NOT NULL DEFAULT '0',
  `ClassType` varchar(81) NOT NULL DEFAULT '',
  `Sex` varchar(3) NOT NULL DEFAULT '',
  `StartName` varchar(33) NOT NULL DEFAULT '',
  `StartBlock` tinyint unsigned NOT NULL DEFAULT '0',
  `NoTiming` tinyint unsigned NOT NULL DEFAULT '0',
  `FreeStart` tinyint unsigned NOT NULL DEFAULT '0',
  `RequestStart` tinyint unsigned NOT NULL DEFAULT '0',
  `IgnoreStart` tinyint unsigned NOT NULL DEFAULT '0',
  `FirstStart` int NOT NULL DEFAULT '0',
  `StartInterval` int NOT NULL DEFAULT '0',
  `Vacant` tinyint unsigned NOT NULL DEFAULT '0',
  `Reserved` smallint unsigned NOT NULL DEFAULT '0',
  `ClassFee` int NOT NULL DEFAULT '0',
  `HighClassFee` int NOT NULL DEFAULT '0',
  `SecondHighClassFee` int NOT NULL DEFAULT '0',
  `ClassFeeRed` int NOT NULL DEFAULT '0',
  `HighClassFeeRed` int NOT NULL DEFAULT '0',
  `SecondHighClassFeeRed` int NOT NULL DEFAULT '0',
  `SortIndex` int NOT NULL DEFAULT '0',
  `MaxTime` int NOT NULL DEFAULT '0',
  `Status` varchar(5) NOT NULL DEFAULT '',
  `DirectResult` tinyint NOT NULL DEFAULT '0',
  `Bib` varchar(17) NOT NULL DEFAULT '',
  `BibMode` varchar(3) NOT NULL DEFAULT '',
  `Unordered` tinyint unsigned NOT NULL DEFAULT '0',
  `Heat` tinyint unsigned NOT NULL DEFAULT '0',
  `Locked` tinyint unsigned NOT NULL DEFAULT '0',
  `Qualification` mediumtext NOT NULL,
  `NumberMaps` smallint NOT NULL DEFAULT '0',
  `Result` varchar(49) NOT NULL DEFAULT '',
  `TransferFlags` int NOT NULL DEFAULT '0',
  `SplitPrint` varchar(81) NOT NULL DEFAULT '',
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) NOT NULL DEFAULT '',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oClub`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oClub` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) NOT NULL DEFAULT '',
  `District` int NOT NULL DEFAULT '0',
  `ShortName` varchar(17) NOT NULL DEFAULT '',
  `CareOf` varchar(63) NOT NULL DEFAULT '',
  `Street` varchar(83) NOT NULL DEFAULT '',
  `City` varchar(47) NOT NULL DEFAULT '',
  `State` varchar(47) NOT NULL DEFAULT '',
  `ZIP` varchar(23) NOT NULL DEFAULT '',
  `EMail` varchar(129) NOT NULL DEFAULT '',
  `Phone` varchar(65) NOT NULL DEFAULT '',
  `Nationality` varchar(7) NOT NULL DEFAULT '',
  `Country` varchar(47) NOT NULL DEFAULT '',
  `Type` varchar(41) NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `Invoice` varchar(3) NOT NULL DEFAULT '',
  `InvoiceNo` smallint unsigned NOT NULL DEFAULT '0',
  `StartGroup` int NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=3308 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oControl`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oControl` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) NOT NULL DEFAULT '',
  `Numbers` varchar(128) NOT NULL DEFAULT '',
  `Status` int unsigned NOT NULL DEFAULT '0',
  `TimeAdjust` int NOT NULL DEFAULT '0',
  `MinTime` int NOT NULL DEFAULT '0',
  `xpos` int NOT NULL DEFAULT '0',
  `ypos` int NOT NULL DEFAULT '0',
  `latcrd` int NOT NULL DEFAULT '0',
  `longcrd` int NOT NULL DEFAULT '0',
  `Rogaining` int NOT NULL DEFAULT '0',
  `Radio` tinyint unsigned NOT NULL DEFAULT '0',
  `Unit` smallint unsigned NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=35 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oCounter`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oCounter` (
  `CounterId` int NOT NULL,
  `oControl` int unsigned NOT NULL DEFAULT '0',
  `oCourse` int unsigned NOT NULL DEFAULT '0',
  `oClass` int unsigned NOT NULL DEFAULT '0',
  `oCard` int unsigned NOT NULL DEFAULT '0',
  `oClub` int unsigned NOT NULL DEFAULT '0',
  `oPunch` int unsigned NOT NULL DEFAULT '0',
  `oRunner` int unsigned NOT NULL DEFAULT '0',
  `oTeam` int unsigned NOT NULL DEFAULT '0',
  `oEvent` int unsigned NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oCourse`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oCourse` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(64) NOT NULL DEFAULT '',
  `Controls` varchar(512) NOT NULL DEFAULT '',
  `Length` int unsigned NOT NULL DEFAULT '0',
  `Legs` varchar(1024) NOT NULL DEFAULT '',
  `NumberMaps` smallint NOT NULL DEFAULT '0',
  `StartName` varchar(33) NOT NULL DEFAULT '',
  `Climb` smallint NOT NULL DEFAULT '0',
  `RPointLimit` int NOT NULL DEFAULT '0',
  `RTimeLimit` int NOT NULL DEFAULT '0',
  `RReduction` int NOT NULL DEFAULT '0',
  `RReductionMethod` tinyint unsigned NOT NULL DEFAULT '0',
  `FirstAsStart` tinyint unsigned NOT NULL DEFAULT '0',
  `LastAsFinish` tinyint unsigned NOT NULL DEFAULT '0',
  `CControl` smallint unsigned NOT NULL DEFAULT '0',
  `Shorten` int NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oEvent`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oEvent` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) NOT NULL DEFAULT '',
  `Annotation` varchar(128) NOT NULL DEFAULT '',
  `Date` varchar(32) NOT NULL DEFAULT '',
  `ZeroTime` int unsigned NOT NULL DEFAULT '0',
  `NameId` varchar(64) NOT NULL DEFAULT '',
  `BuildVersion` int unsigned NOT NULL DEFAULT '0',
  `CardFee` int NOT NULL DEFAULT '0',
  `EliteFee` int NOT NULL DEFAULT '0',
  `EntryFee` int NOT NULL DEFAULT '0',
  `YouthFee` int NOT NULL DEFAULT '0',
  `YouthAge` tinyint unsigned NOT NULL DEFAULT '0',
  `SeniorAge` tinyint unsigned NOT NULL DEFAULT '0',
  `Account` varchar(61) NOT NULL DEFAULT '',
  `PaymentDue` int NOT NULL DEFAULT '0',
  `OrdinaryEntry` int NOT NULL DEFAULT '0',
  `SecondEntryDate` int NOT NULL DEFAULT '0',
  `LateEntryFactor` varchar(13) NOT NULL DEFAULT '',
  `SecondEntryFactor` varchar(13) NOT NULL DEFAULT '',
  `Organizer` mediumtext NOT NULL,
  `CareOf` varchar(63) NOT NULL DEFAULT '',
  `Street` varchar(65) NOT NULL DEFAULT '',
  `Address` varchar(65) NOT NULL DEFAULT '',
  `EMail` mediumtext NOT NULL,
  `Homepage` mediumtext NOT NULL,
  `Phone` varchar(65) NOT NULL DEFAULT '',
  `UseEconomy` tinyint unsigned NOT NULL DEFAULT '0',
  `UseSpeaker` tinyint unsigned NOT NULL DEFAULT '0',
  `SkipRunnerDb` tinyint unsigned NOT NULL DEFAULT '0',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `MaxTime` int NOT NULL DEFAULT '0',
  `DiffTime` int NOT NULL DEFAULT '0',
  `PreEvent` varchar(129) NOT NULL DEFAULT '',
  `PostEvent` varchar(129) NOT NULL DEFAULT '',
  `ImportStamp` varchar(29) NOT NULL DEFAULT '',
  `EventNumber` tinyint NOT NULL DEFAULT '0',
  `CurrencyFactor` smallint NOT NULL DEFAULT '0',
  `CurrencySymbol` varchar(11) NOT NULL DEFAULT '',
  `CurrencySeparator` varchar(5) NOT NULL DEFAULT '',
  `CurrencyPreSymbol` tinyint NOT NULL DEFAULT '0',
  `CurrencyCode` varchar(11) NOT NULL DEFAULT '',
  `UTC` tinyint NOT NULL DEFAULT '0',
  `Analysis` tinyint NOT NULL DEFAULT '0',
  `SPExtra` mediumtext NOT NULL,
  `IVExtra` mediumtext NOT NULL,
  `Features` mediumtext NOT NULL,
  `EntryExtra` mediumtext NOT NULL,
  `NumStages` tinyint NOT NULL DEFAULT '0',
  `BibGap` tinyint unsigned NOT NULL DEFAULT '0',
  `BibsPerClass` tinyint unsigned NOT NULL DEFAULT '0',
  `LongTimes` tinyint unsigned NOT NULL DEFAULT '0',
  `SubSeconds` tinyint unsigned NOT NULL DEFAULT '0',
  `PayModes` mediumtext NOT NULL,
  `TransferFlags` int NOT NULL DEFAULT '0',
  `InvoiceDate` int NOT NULL DEFAULT '0',
  `StartGroups` mediumtext NOT NULL,
  `MergeTag` varchar(25) NOT NULL DEFAULT '',
  `MergeInfo` mediumtext NOT NULL,
  `SplitPrint` varchar(81) NOT NULL DEFAULT '',
  `NoVacantBib` tinyint unsigned NOT NULL DEFAULT '0',
  `RunnerIdTypes` mediumtext NOT NULL,
  `ExtraFields` mediumtext NOT NULL,
  `ControlMap` mediumtext NOT NULL,
  `OldCards` tinyint unsigned NOT NULL DEFAULT '0',
  `Lists` mediumtext NOT NULL,
  `Machine` mediumtext NOT NULL,
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oImage`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oImage` (
  `Id` bigint unsigned NOT NULL DEFAULT '0',
  `Filename` text NOT NULL,
  `Image` longblob
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oMonitor`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oMonitor` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Client` varchar(64) NOT NULL DEFAULT '',
  `Count` int unsigned NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oPunch`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oPunch` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `CardNo` int NOT NULL DEFAULT '0',
  `Time` int NOT NULL DEFAULT '0',
  `Type` int NOT NULL DEFAULT '0',
  `Unit` int NOT NULL DEFAULT '0',
  `Origin` int NOT NULL DEFAULT '0',
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oRunner`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oRunner` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(64) NOT NULL DEFAULT '',
  `CardNo` int NOT NULL DEFAULT '0',
  `Club` int NOT NULL DEFAULT '0',
  `Class` int NOT NULL DEFAULT '0',
  `Course` int NOT NULL DEFAULT '0',
  `StartNo` int NOT NULL DEFAULT '0',
  `StartTime` int NOT NULL DEFAULT '0',
  `FinishTime` int NOT NULL DEFAULT '0',
  `Status` int NOT NULL DEFAULT '0',
  `Card` int NOT NULL DEFAULT '0',
  `MultiR` varchar(200) NOT NULL DEFAULT '',
  `InputTime` int NOT NULL DEFAULT '0',
  `InputStatus` int NOT NULL DEFAULT '0',
  `InputPoints` int NOT NULL DEFAULT '0',
  `InputPlace` int NOT NULL DEFAULT '0',
  `Fee` int NOT NULL DEFAULT '0',
  `CardFee` int NOT NULL DEFAULT '0',
  `Paid` int NOT NULL DEFAULT '0',
  `PayMode` tinyint unsigned NOT NULL DEFAULT '0',
  `Taxable` int NOT NULL DEFAULT '0',
  `BirthYear` int NOT NULL DEFAULT '0',
  `Bib` varchar(17) NOT NULL DEFAULT '',
  `Rank` int NOT NULL DEFAULT '0',
  `EntryDate` int NOT NULL DEFAULT '0',
  `EntryTime` int NOT NULL DEFAULT '0',
  `Sex` varchar(3) NOT NULL DEFAULT '',
  `Nationality` varchar(7) NOT NULL DEFAULT '',
  `Country` varchar(47) NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `ExtId2` bigint NOT NULL DEFAULT '0',
  `Priority` tinyint unsigned NOT NULL DEFAULT '0',
  `Phone` varchar(41) NOT NULL DEFAULT '',
  `RaceId` int NOT NULL DEFAULT '0',
  `TimeAdjust` int NOT NULL DEFAULT '0',
  `PointAdjust` int NOT NULL DEFAULT '0',
  `TransferFlags` int NOT NULL DEFAULT '0',
  `Shorten` tinyint unsigned NOT NULL DEFAULT '0',
  `EntrySource` int NOT NULL DEFAULT '0',
  `Heat` tinyint unsigned NOT NULL DEFAULT '0',
  `Reference` int NOT NULL DEFAULT '0',
  `NoRestart` tinyint unsigned NOT NULL DEFAULT '0',
  `InputResult` mediumtext NOT NULL,
  `StartGroup` int NOT NULL DEFAULT '0',
  `Family` int NOT NULL DEFAULT '0',
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) NOT NULL DEFAULT '',
  `Annotation` mediumtext NOT NULL,
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oTeam`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oTeam` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(64) NOT NULL DEFAULT '',
  `Runners` varchar(256) NOT NULL DEFAULT '',
  `Club` int NOT NULL DEFAULT '0',
  `Class` int NOT NULL DEFAULT '0',
  `StartTime` int NOT NULL DEFAULT '0',
  `FinishTime` int NOT NULL DEFAULT '0',
  `Status` int NOT NULL DEFAULT '0',
  `StartNo` int NOT NULL DEFAULT '0',
  `InputTime` int NOT NULL DEFAULT '0',
  `InputStatus` int NOT NULL DEFAULT '0',
  `InputPoints` int NOT NULL DEFAULT '0',
  `InputPlace` int NOT NULL DEFAULT '0',
  `Fee` int NOT NULL DEFAULT '0',
  `Paid` int NOT NULL DEFAULT '0',
  `PayMode` tinyint unsigned NOT NULL DEFAULT '0',
  `Taxable` int NOT NULL DEFAULT '0',
  `EntryDate` int NOT NULL DEFAULT '0',
  `EntryTime` int NOT NULL DEFAULT '0',
  `Nationality` varchar(7) NOT NULL DEFAULT '',
  `Country` varchar(47) NOT NULL DEFAULT '',
  `Bib` varchar(17) NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `Priority` tinyint unsigned NOT NULL DEFAULT '0',
  `SortIndex` smallint NOT NULL DEFAULT '0',
  `TimeAdjust` int NOT NULL DEFAULT '0',
  `PointAdjust` int NOT NULL DEFAULT '0',
  `TransferFlags` int NOT NULL DEFAULT '0',
  `EntrySource` int NOT NULL DEFAULT '0',
  `Heat` tinyint unsigned NOT NULL DEFAULT '0',
  `NoRestart` tinyint unsigned NOT NULL DEFAULT '0',
  `InputResult` mediumtext NOT NULL,
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) NOT NULL DEFAULT '',
  `Annotation` mediumtext NOT NULL,
  `Modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `Counter` (`Counter`),
  KEY `Modified` (`Modified`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oos_card_readouts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oos_card_readouts` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `CardNo` int NOT NULL,
  `CardType` varchar(10) NOT NULL DEFAULT '',
  `Punches` varchar(3040) NOT NULL DEFAULT '',
  `Voltage` int unsigned NOT NULL DEFAULT '0',
  `OwnerData` text,
  `ReadAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Metadata` text,
  PRIMARY KEY (`Id`),
  KEY `idx_cardno` (`CardNo`),
  KEY `idx_readat` (`ReadAt`)
) ENGINE=InnoDB AUTO_INCREMENT=29 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oos_club_logo`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oos_club_logo` (
  `EventorId` int NOT NULL,
  `SmallPng` mediumblob NOT NULL,
  `LargePng` mediumblob,
  `UpdatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`EventorId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oos_map_files`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oos_map_files` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `FileName` varchar(255) NOT NULL DEFAULT '',
  `FileData` longblob NOT NULL,
  `UploadedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`Id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

LOCK TABLES `oEvent` WRITE;
/*!40000 ALTER TABLE `oEvent` DISABLE KEYS */;
INSERT INTO `oEvent` VALUES (2,'Test competition','','2026-04-01',216000,'meos_20251222_001121_2BC',1702,25,130,90,50,16,0,'',0,0,0,'50 %','','','','','','','','',0,0,0,0,0,0,'','','',0,1,'kr','.',0,'',0,0,'','','SP+EC+CL+CC+NW+VA+RF+SL+BB+RD','',0,0,0,0,0,'',3,0,'','AQBc8Wsa1xVP','','',0,'','','',0,'<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\n\n<Lists>\n</Lists>\n','','2025-12-21 23:11:43',1,0);
/*!40000 ALTER TABLE `oEvent` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

