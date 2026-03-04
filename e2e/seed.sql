
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
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oCard_Counter_idx` (`Counter`),
  KEY `oCard_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=51 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oClass`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oClass` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) NOT NULL DEFAULT '',
  `Course` int NOT NULL DEFAULT '0',
  `MultiCourse` mediumtext,
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
  `Qualification` mediumtext,
  `NumberMaps` smallint NOT NULL DEFAULT '0',
  `Result` varchar(49) NOT NULL DEFAULT '',
  `TransferFlags` int NOT NULL DEFAULT '0',
  `SplitPrint` varchar(81) NOT NULL DEFAULT '',
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) NOT NULL DEFAULT '',
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oClass_Counter_idx` (`Counter`),
  KEY `oClass_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=38 DEFAULT CHARSET=utf8mb3;
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
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oClub_Counter_idx` (`Counter`),
  KEY `oClub_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=888888922 DEFAULT CHARSET=utf8mb3;
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
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oControl_Counter_idx` (`Counter`),
  KEY `oControl_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb3;
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
  `Modified` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`CounterId`)
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
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oCourse_Counter_idx` (`Counter`),
  KEY `oCourse_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=36 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oEvent`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oEvent` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) NOT NULL,
  `Annotation` varchar(128) NOT NULL DEFAULT '',
  `Date` varchar(32) NOT NULL,
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
  `Organizer` mediumtext,
  `CareOf` varchar(63) NOT NULL DEFAULT '',
  `Street` varchar(65) NOT NULL DEFAULT '',
  `Address` varchar(65) NOT NULL DEFAULT '',
  `EMail` mediumtext,
  `Homepage` mediumtext,
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
  `SPExtra` mediumtext,
  `IVExtra` mediumtext,
  `Features` mediumtext,
  `EntryExtra` mediumtext,
  `NumStages` tinyint NOT NULL DEFAULT '0',
  `BibGap` tinyint unsigned NOT NULL DEFAULT '0',
  `BibsPerClass` tinyint unsigned NOT NULL DEFAULT '0',
  `LongTimes` tinyint unsigned NOT NULL DEFAULT '0',
  `SubSeconds` tinyint unsigned NOT NULL DEFAULT '0',
  `PayModes` mediumtext,
  `TransferFlags` int NOT NULL DEFAULT '0',
  `InvoiceDate` int NOT NULL DEFAULT '0',
  `StartGroups` mediumtext,
  `MergeTag` varchar(25) NOT NULL DEFAULT '',
  `MergeInfo` mediumtext,
  `SplitPrint` varchar(81) NOT NULL DEFAULT '',
  `NoVacantBib` tinyint unsigned NOT NULL DEFAULT '0',
  `RunnerIdTypes` mediumtext,
  `ExtraFields` mediumtext,
  `ControlMap` mediumtext,
  `OldCards` tinyint unsigned NOT NULL DEFAULT '0',
  `Lists` mediumtext,
  `Machine` mediumtext,
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oEvent_Counter_idx` (`Counter`),
  KEY `oEvent_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `oMonitor`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oMonitor` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Client` varchar(64) NOT NULL DEFAULT '',
  `Count` int unsigned NOT NULL DEFAULT '0',
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oMonitor_Counter_idx` (`Counter`),
  KEY `oMonitor_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb3;
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
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oPunch_Counter_idx` (`Counter`),
  KEY `oPunch_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb3;
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
  `InputResult` mediumtext,
  `StartGroup` int NOT NULL DEFAULT '0',
  `Family` int NOT NULL DEFAULT '0',
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) NOT NULL DEFAULT '',
  `Annotation` mediumtext,
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oRunner_Counter_idx` (`Counter`),
  KEY `oRunner_Modified_idx` (`Modified`)
) ENGINE=MyISAM AUTO_INCREMENT=113 DEFAULT CHARSET=utf8mb3;
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
  `InputResult` mediumtext,
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) NOT NULL DEFAULT '',
  `Annotation` mediumtext,
  `Modified` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oTeam_Counter_idx` (`Counter`),
  KEY `oTeam_Modified_idx` (`Modified`)
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
  `Metadata` text,
  `ReadAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`Id`),
  KEY `idx_cardno` (`CardNo`),
  KEY `idx_readat` (`ReadAt`)
) ENGINE=InnoDB AUTO_INCREMENT=123 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
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
INSERT INTO `oEvent` VALUES (1,'My example tävling','','2026-04-15',0,'itest',1702,25,160,110,70,16,0,'XXX-XXXX',20200101,-1,0,'50 %','','Melin Software HB','','','','','','',1,1,0,0,-1,0,'','','',0,1,'kr','.',0,'',0,0,'','','SP+EC+CL+CC+NW+FO+VA+RF+SL+BB+RD','',0,0,0,0,0,'',3,0,'','frAQBc8Wsa1x','','',0,'','','',0,'<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\n\n<Lists>\n<ListParam Name=\"Kjula IF Championships 2015\">\n<ListId>Tindresultinclub</ListId>\n<ClassId>1;2;3</ClassId>\n<LegNumber>-1</LegNumber>\n<FromControl>-1</FromControl>\n<ToControl>-1</ToControl>\n<Title>Kjula IF Championships 2015</Title>\n<InputNumber>15</InputNumber>\n</ListParam>\n<ListParam Name=\"Invoices\">\n<ListId>C30</ListId>\n<LegNumber>-1</LegNumber>\n<FromControl>-1</FromControl>\n<ToControl>-1</ToControl>\n<Title>Invoicing</Title>\n<PageBreak>true</PageBreak>\n<ShowNamedSplits>true</ShowNamedSplits>\n<InputNumber>15</InputNumber>\n</ListParam>\n</Lists>\n','','2026-02-12 11:16:36',4,0);
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

LOCK TABLES `oCounter` WRITE;
/*!40000 ALTER TABLE `oCounter` DISABLE KEYS */;
INSERT INTO `oCounter` VALUES (1,26,3,26,44,28,3,59,1,4,NULL);
/*!40000 ALTER TABLE `oCounter` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oClass` WRITE;
/*!40000 ALTER TABLE `oClass` DISABLE KEYS */;
INSERT INTO `oClass` VALUES (1,'Öppen 1',1,'','(DR:NO:0:0:0:-1)',1,'',0,0,0,1,'Open','','Start 1',1,0,0,0,0,0,0,0,0,110,165,0,70,105,0,10,0,'',0,'','',0,0,0,'',0,'',0,'',0,0,'','2026-02-17 13:41:47',26,0),(2,'Öppen 2',2,'','',2,'',0,0,0,0,'Open','','Start 2',0,0,0,0,0,0,0,0,0,110,165,0,70,105,0,20,0,'',0,'','',0,0,0,'',0,'',0,'',0,0,'','2026-02-17 13:41:47',5,0),(3,'Öppen 3',3,'','',3,'',0,0,0,0,'Open','','Start 1',0,0,0,0,0,0,0,0,0,110,165,0,70,105,0,30,0,'',0,'','',0,0,0,'',0,'',0,'',0,0,'','2026-02-17 13:41:47',6,0);
/*!40000 ALTER TABLE `oClass` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oCourse` WRITE;
/*!40000 ALTER TABLE `oCourse` DISABLE KEYS */;
INSERT INTO `oCourse` VALUES (1,'Bana 1','67;39;78;53;44;50;60;41;42;37;150;64;42;77;54;100;',7340,'',30,'',0,0,0,0,0,0,0,0,0,'2026-02-12 14:38:15',1,0),(2,'Bana 2','81;50;40;150;100;',7060,'',30,'',0,0,0,0,0,0,0,0,0,'2015-04-15 15:42:18',2,0),(3,'Bana 3','61;34;50;79;89;150;93;100;',3400,'',30,'',0,0,0,0,0,0,0,0,0,'2026-02-17 12:40:12',3,0);
/*!40000 ALTER TABLE `oCourse` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oControl` WRITE;
/*!40000 ALTER TABLE `oControl` DISABLE KEYS */;
INSERT INTO `oControl` VALUES (34,'','34',0,0,0,0,0,0,0,0,0,0,'2026-02-17 12:40:02',1,0),(37,'','37',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',2,0),(39,'','39',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',3,0),(40,'','40',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',4,0),(41,'','41',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',5,0),(42,'','42',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',6,0),(44,'','44',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',7,0),(50,'Radio 1','50',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',8,0),(53,'','53',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',9,0),(54,'','54',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',10,0),(60,'','60',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',11,0),(61,'','61',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',12,0),(64,'','64',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',13,0),(67,'','67',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',14,0),(77,'','77',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',15,0),(78,'','78',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',16,0),(79,'','79',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',17,0),(81,'','81',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',18,0),(89,'','89',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',19,0),(93,'','93',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',20,0),(100,'Förvarning','100',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',21,0),(150,'Radio 2','150',0,0,0,0,0,0,0,0,0,0,'2025-01-01 01:00:00',22,0),(200,'Pre-start','200',0,0,0,0,0,0,0,0,0,0,'2025-12-23 00:19:12',26,0);
/*!40000 ALTER TABLE `oControl` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oClub` WRITE;
/*!40000 ALTER TABLE `oClub` DISABLE KEYS */;
INSERT INTO `oClub` VALUES (2,'Ankarsrums OK',14,'','Anders Strömbäck','Duvgatan 10','VÄSTERVIK','','59342','ankarsrumsok@passagen.se','','SWE','','',38,'',100,0,'2015-04-15 15:48:31',1,0),(3,'Bodafors OK',14,'','Stefan Reiver','Pär Hörbergs väg 31','BODAFORS','','57161','stefan.reiver@signalbyran.se','','SWE','','',51,'',101,0,'2015-04-15 15:48:31',2,0),(4,'Burseryds IF',14,'','','Box 41','BURSERYD','','33026','','','SWE','','',64,'',102,0,'2015-04-15 15:48:31',3,0),(1,'Degerfors OK',18,'','Lars Broström','Götvägen 22','DEGERFORS','','69332','tore.martinsson@gmail.com','','SWE','','',25,'',103,0,'2015-04-15 15:48:31',4,0),(5,'Domnarvets GOIF',3,'','','Hemgatan 71','BORLÄNGE','','78473','info@domnarvet.com','','SWE','','',77,'',104,0,'2015-04-15 15:48:31',5,0),(26,'FK Snapphanarna',13,'','','Box 1069','ÄNGELHOLM','','26221','info@snapphanarna.se','','SWE','','',350,'',105,0,'2015-04-15 15:48:31',6,0),(6,'Gamleby OK',14,'','','Box 60','GAMLEBY','','59421','gok@home.se','','SWE','','',90,'',106,0,'2015-04-15 15:48:31',7,0),(7,'Grangärde OK',3,'','L Dahlström','Idrottsvägen 9','LUDVIKA','','77155','lars.dahlstroem@telia.com','','SWE','','',103,'',107,0,'2015-04-15 15:48:31',8,0),(8,'Halmstad OK',7,'','C/o Eva Carliden','Valnötsvägen 1','HALMSTAD','','30256','kansli@halmstadok.se','','SWE','','',116,'',108,0,'2015-04-15 15:48:31',9,0),(9,'Hedesunda IF',5,'','','Åsvägen 151','HEDESUNDA','','81040','susanne.aslund33@gmail.com','','SWE','','',129,'',109,0,'2015-04-15 15:48:31',10,0),(11,'Hultsfreds OK',14,'','Flöjtstigen 33','Hagadalsgatan 29','HULTSFRED','','57736','hultsfreds.ok@telia.com','','SWE','','',155,'',110,0,'2015-04-15 15:48:31',11,0),(12,'Häverödals SK',17,'','c/o Lennart Andersson','Snäckviksvägen 31','HALLSTAVIK','','76394','boeivor.westling@telia.com','','SWE','','',168,'',111,0,'2015-04-15 15:48:31',12,0),(13,'IFK Kiruna',11,'','Orienteringssektionen','Idrottsvägen 10','KIRUNA','','98139','info@ifkkiruna.se','','SWE','','',181,'',112,0,'2015-04-15 15:48:31',13,0),(28,'IK Surd',6,'','Bo Lundgren Ol-sektionen','Bäckebolslyckan 32','HISINGS BACKA','','42254','bo.lundgren@mbox.309.swipnet.se','','SWE','','',376,'',113,0,'2015-04-15 15:48:31',14,0),(14,'K 3 IF',20,'','Tornie Ottersten','PL 1','KARLSBORG','','54681','idrott-k3@mil.se','','SWE','','',194,'',114,0,'2015-04-15 15:48:31',15,0),(15,'Kjula IF',16,'','Jarl Palm','Cypressvägen 10','ESKILSTUNA','','63506','j_palm@hotmail.com','','SWE','','',207,'',115,0,'2015-04-15 15:48:31',16,0),(16,'Krokeks OK',23,'','','Gamla Krokeksvägen 20','KOLMÅRDEN','','61833','maria.nordwall@zeta.telenordia.se','','SWE','','',220,'',116,0,'2015-04-15 15:48:31',17,0),(17,'Laxå OK',12,'','','Box 73','LAXÅ','','69522','hakan.persson@esab.se','','SWE','','',233,'',117,0,'2015-04-15 15:48:31',18,0),(18,'Ljusne-Ala OK',8,'','','Gamla Riksvägen  51','LJUSNE','','82020','stig_lundstrom@hotmail.com','','SWE','','',246,'',118,0,'2015-04-15 15:48:31',19,0),(20,'Niilivaara IS',11,'','Magnus Säveros','Nilivaara 154','GÄLLIVARE','','98291','msaveros@gmail.com','','SWE','','',272,'',119,0,'2015-04-15 15:48:31',20,0),(21,'Nyköpings OK',16,'','Klubbhuset','Ekensberg','NYKÖPING','','61165','nykopingsok@telia.com','','SWE','','',285,'',120,0,'2015-04-15 15:48:31',21,0),(10,'OK Forsarna',9,'','C/o Halvarsson','Snickarvägen 12','BISPGÅRDEN','','84073','info@okforsarna.com','','SWE','','',142,'',121,0,'2015-04-15 15:48:31',22,0),(23,'OK Roto',2,'','Sven-Erik Grund','Dernäs 230','FRÄNDEFORS','','46295','eva-lena@privat.utfors.se','','SWE','','',311,'',122,0,'2015-04-15 15:48:31',23,0),(30,'OK Tranan',20,'','Kristina Nilsson','Björkvägen 19','TRANEMO','','51432','oktranan@outlook.com','','SWE','','',402,'',123,0,'2015-04-15 15:48:31',24,0),(22,'Robertsfors IK',19,'','c/o Helena Königsson','Slöjdvägen 4','SÄVAR','','91832','mikaelyngvesson@yahoo.se','','SWE','','',298,'',124,0,'2015-04-15 15:48:31',25,0),(24,'Sigtuna OK',17,'','Selander','Tvärgränd 5','SIGTUNA','','19330','sigtunaok@canit.se','','SWE','','',324,'',125,0,'2015-04-15 15:48:31',26,0),(25,'Skellefteå OK',19,'','','Mossgatan','SKELLEFTEÅ','','93170','skelleftea.ok@gmail.com','','SWE','','',337,'',126,0,'2015-04-15 15:48:31',27,0),(888888888,'Vacant',0,'','','','','','','','','','','',0,'',127,0,'2015-04-15 15:48:31',28,0);
/*!40000 ALTER TABLE `oClub` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oRunner` WRITE;
/*!40000 ALTER TABLE `oRunner` DISABLE KEYS */;
INSERT INTO `oRunner` VALUES (8,'Monica Henriksson',500803,2,1,0,1,456600,502350,3,27,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',1,0),(14,'Malin Johannesson',501438,16,1,0,2,1,502850,1,13,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',2,0),(10,'Nilsson Collryd',501061,20,1,0,3,1,498630,1,5,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',3,0),(22,'Roger Thörnblom',502141,15,1,0,4,1,498080,1,41,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',4,0),(21,'Albin Bergman',2220164,12,1,0,5,1,0,0,0,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2025-12-22 22:42:43',58,0),(25,'Vakant',0,888888888,1,0,6,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',6,0),(12,'Helena Bergström',501259,13,1,0,7,1,503970,1,9,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',7,0),(11,'Magnus Johansson',501162,15,1,0,8,1,0,4,19,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',8,0),(9,'Bo-Göran Persson',500944,15,1,0,9,1,501770,3,7,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',9,0),(19,'Gun Karlsson',501929,10,1,0,10,1,507740,3,44,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',10,0),(2,'Thommie Antonsson',500196,4,1,0,11,1,504460,1,4,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',11,0),(18,'Monica Johansson',501807,15,1,0,12,1,507050,1,42,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',12,0),(4,'Charlotte Olovsson',500416,7,1,0,13,1,507590,1,31,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',13,0),(6,'Eva Rådberg',500671,25,1,0,14,1,0,0,50,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2026-02-17 13:39:21',14,0),(24,'Vakant',0,888888888,1,0,15,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',15,0),(17,'Björn Carlsson',501685,5,1,0,16,1,505790,1,23,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',16,0),(15,'Simon Johansson',501524,21,1,0,17,1,502920,1,40,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',17,0),(16,'Filip Johansson',501588,9,1,0,18,1,499220,1,35,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',18,0),(5,'Ted Björkman',500545,23,1,0,19,1,507180,1,39,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',19,0),(7,'Stig Gösswein',500699,4,1,0,20,1,503730,1,10,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',20,0),(3,'Annelie Najvik',500319,15,1,0,21,1,500110,1,1,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',21,0),(1,'Linda Klick',500188,7,1,0,22,1,507790,1,25,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',22,0),(13,'Tova Askeljung',501320,3,1,0,23,1,501270,1,38,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',23,0),(23,'Vakant',0,888888888,1,0,24,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',24,0),(20,'Johan Jonsson',501957,15,1,0,25,1,501350,1,43,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',25,0),(26,'Ann Sjödin',502583,15,2,0,1,1,0,4,11,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',26,0),(30,'Stefan Hersén',502935,12,2,0,2,1,498980,1,37,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',27,0),(37,'Vakant',0,888888888,2,0,3,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',28,0),(31,'Stig Vedin',503101,22,2,0,4,1,502410,1,14,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',29,0),(33,'Oskar Svensson',503267,8,2,0,5,1,499150,1,32,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',30,0),(27,'Kirsten Nilsson',502673,18,2,0,6,1,503320,1,2,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',31,0),(36,'Kim Johansson',503525,15,2,0,7,1,496700,1,29,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',32,0),(38,'Vakant',0,888888888,2,0,8,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',33,0),(34,'Ewa Fröjd',503381,6,2,0,9,1,503960,1,12,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',34,0),(28,'Åsa Robertsson',502718,17,2,0,10,1,506430,0,3,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,-1,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2026-02-12 11:17:22',59,0),(35,'Leif Frisell',503457,12,2,0,11,1,503920,1,21,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',36,0),(39,'Vakant',0,888888888,2,0,12,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',37,0),(29,'Gunnar Wickberg',502846,6,2,0,13,1,504800,1,22,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',38,0),(32,'Sara Stridfeldt',503129,28,2,0,14,1,502450,1,33,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',39,0),(40,'Börje Löfgren',503962,9,3,0,1,1,488960,1,8,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',40,0),(48,'Isabella Johansson',504678,1,3,0,2,1,494580,3,36,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',41,0),(43,'Ann Thulin',504188,15,3,0,3,1,496200,1,6,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',42,0),(52,'Vakant',0,888888888,3,0,4,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',43,0),(49,'Hjalmar Enström',504804,30,3,0,5,1,490040,1,34,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',44,0),(51,'Kristina Pettersson',504987,15,3,0,6,1,493920,1,20,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',45,0),(50,'Thomas Hilmersson',504862,21,3,0,7,1,496030,1,18,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',46,0),(47,'Susanne Jansson',504636,15,3,0,8,1,488200,1,17,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',47,0),(53,'Vakant',0,888888888,3,0,9,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',48,0),(41,'Leif Wallström',503981,3,3,0,10,1,494590,1,30,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',49,0),(44,'Hampus Berggren',504347,2,3,0,11,1,494830,1,15,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',50,0),(46,'Ronny Backman',504542,8,3,0,12,1,486830,1,26,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',51,0),(45,'Mats Mollén',504368,15,3,0,13,1,496340,1,28,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',52,0),(54,'Vakant',0,888888888,3,0,14,1,0,0,0,'',0,1,0,0,0,0,0,0,0,0,'',0,0,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',53,0),(42,'Vanja Engvall',504134,15,3,0,15,1,486600,1,16,'',0,1,0,0,110,0,0,0,0,0,'',0,20150415,0,'','','',0,0,0,'',0,0,0,0,0,0,0,0,0,'',0,0,0,0,'','','2015-04-15 15:48:15',54,0);
/*!40000 ALTER TABLE `oRunner` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oCard` WRITE;
/*!40000 ALTER TABLE `oCard` DISABLE KEYS */;
INSERT INTO `oCard` VALUES (27,500803,1568235,0,0,'3-68400.0;67-45929.0;39-46198.0;78-46467.0;53-46736.0;44-47005.0;60-47543.0;41-47812.0;42-48082.0;37-48351.0;150-48620.0;64-48889.0;42-49158.0;77-49427.0;54-49696.0;100-49965.0;2-50235.0;','2025-01-01 01:00:00',1,0),(13,501438,1668285,0,0,'','2026-02-17 13:41:51',2,0),(5,501061,1667863,0,0,'3-68400.0;67-45926.0;39-46172.0;78-46418.0;53-46664.0;44-46910.0;50-47156.0;60-47402.0;41-47648.0;42-47894.0;37-48140.0;150-48386.0;64-48632.0;42-48878.0;77-49124.0;54-49370.0;100-49616.0;2-49863.0;','2025-01-01 01:00:00',3,0),(41,502141,1667808,0,0,'3-68400.0;67-45932.0;39-46174.0;78-46416.0;53-46658.0;44-46901.0;50-47143.0;60-47385.0;41-47627.0;42-47870.0;37-48112.0;150-48354.0;64-48596.0;42-48839.0;77-49081.0;54-49323.0;100-49565.0;2-49808.0;','2025-01-01 01:00:00',4,0),(24,502118,1668043,0,0,'3-68400.0;67-45955.0;39-46210.0;78-46466.0;53-46721.0;44-46977.0;50-47232.0;60-47488.0;41-47743.0;42-47999.0;37-48254.0;150-48510.0;64-48765.0;42-49021.0;77-49276.0;54-49532.0;100-49787.0;2-50043.0;','2025-01-01 01:00:00',5,0),(9,501259,1668397,0,0,'3-68400.0;67-45995.0;39-46270.0;78-46545.0;53-46820.0;44-47095.0;50-47370.0;60-47645.0;41-47920.0;42-48196.0;37-48471.0;150-48746.0;64-49021.0;42-49296.0;77-49571.0;54-49846.0;100-50121.0;2-50397.0;','2025-01-01 01:00:00',6,0),(19,501162,1668308,0,0,'3-68400.0;67-45999.0;39-46268.0;78-46537.0;53-46807.0;44-47076.0;50-47345.0;60-47615.0;41-47884.0;42-48153.0;37-48422.0;150-48692.0;64-48961.0;42-49230.0;77-49500.0;54-49769.0;100-50038.0;','2025-01-01 01:00:00',7,0),(7,500944,1468177,0,0,'3-68400.0;67-46001.0;78-46523.0;53-46784.0;44-47045.0;50-47306.0;60-47567.0;41-47828.0;42-48089.0;37-48350.0;150-48611.0;64-48872.0;42-49133.0;54-49655.0;100-49916.0;2-50177.0;','2025-01-01 01:00:00',8,0),(44,501929,1568774,0,0,'3-68400.0;67-46045.0;39-46341.0;78-46636.0;53-46932.0;44-47227.0;60-47818.0;41-48114.0;42-48409.0;37-48705.0;150-49000.0;64-49296.0;42-49591.0;77-49887.0;54-50182.0;100-50478.0;2-50774.0;','2025-01-01 01:00:00',9,0),(4,500196,1668446,0,0,'3-68400.0;67-46035.0;39-46311.0;78-46586.0;53-46862.0;44-47138.0;50-47413.0;60-47689.0;41-47965.0;42-48240.0;37-48516.0;150-48792.0;64-49067.0;42-49343.0;77-49619.0;54-49894.0;100-50170.0;2-50446.0;','2025-01-01 01:00:00',10,0),(42,501807,1668705,0,0,'3-68400.0;67-46060.0;39-46350.0;78-46640.0;53-46931.0;44-47221.0;50-47511.0;60-47802.0;41-48092.0;42-48382.0;37-48672.0;150-48963.0;64-49253.0;42-49543.0;77-49834.0;54-50124.0;100-50414.0;2-50705.0;','2025-01-01 01:00:00',11,0),(31,500416,1668759,0,0,'3-68400.0;67-46072.0;39-46365.0;78-46658.0;53-46951.0;44-47244.0;50-47537.0;60-47830.0;41-48123.0;42-48415.0;37-48708.0;150-49001.0;64-49294.0;42-49587.0;77-49880.0;54-50173.0;100-50466.0;2-50759.0;','2025-01-01 01:00:00',12,0),(23,501685,1668579,0,0,'3-68400.0;67-46090.0;39-46371.0;78-46651.0;53-46932.0;44-47212.0;50-47493.0;60-47773.0;41-48054.0;42-48334.0;37-48615.0;150-48895.0;64-49176.0;42-49456.0;77-49737.0;54-50017.0;100-50298.0;2-50579.0;','2025-01-01 01:00:00',13,0),(40,501524,1668292,0,0,'3-68400.0;67-46083.0;39-46346.0;78-46609.0;53-46872.0;44-47135.0;50-47398.0;60-47661.0;41-47924.0;42-48187.0;37-48450.0;150-48713.0;64-48976.0;42-49239.0;77-49502.0;54-49765.0;100-50028.0;2-50292.0;','2025-01-01 01:00:00',14,0),(35,501588,1667922,0,0,'3-68400.0;67-46070.0;39-46311.0;78-46552.0;53-46792.0;44-47033.0;50-47274.0;60-47514.0;41-47755.0;42-47996.0;37-48237.0;150-48477.0;64-48718.0;42-48959.0;77-49199.0;54-49440.0;100-49681.0;2-49922.0;','2025-01-01 01:00:00',15,0),(39,500545,1668718,0,0,'3-68400.0;67-46126.0;39-46413.0;78-46700.0;53-46987.0;44-47274.0;50-47561.0;60-47848.0;41-48135.0;42-48422.0;37-48709.0;150-48996.0;64-49283.0;42-49570.0;77-49857.0;54-50144.0;100-50431.0;2-50718.0;','2025-01-01 01:00:00',16,0),(10,500699,1668373,0,0,'3-68400.0;67-46116.0;39-46382.0;78-46648.0;53-46914.0;44-47180.0;50-47446.0;60-47712.0;41-47978.0;42-48244.0;37-48510.0;150-48776.0;64-49042.0;42-49308.0;77-49574.0;54-49840.0;100-50106.0;2-50373.0;','2025-01-01 01:00:00',17,0),(1,500319,1668011,0,0,'3-68400.0;67-46104.0;39-46348.0;78-46592.0;53-46836.0;44-47080.0;50-47325.0;60-47569.0;41-47813.0;42-48057.0;37-48301.0;150-48545.0;64-48790.0;42-49034.0;77-49278.0;54-49522.0;100-49766.0;2-50011.0;','2025-01-01 01:00:00',18,0),(25,500188,1668779,0,0,'3-68400.0;67-46158.0;39-46447.0;78-46736.0;53-47025.0;44-47313.0;50-47602.0;60-47891.0;41-48180.0;42-48468.0;37-48757.0;150-49046.0;64-49335.0;42-49623.0;77-49912.0;54-50201.0;100-50490.0;2-50779.0;','2025-01-01 01:00:00',19,0),(38,501320,1668127,0,0,'3-68400.0;67-46129.0;39-46379.0;78-46629.0;53-46879.0;44-47129.0;50-47378.0;60-47628.0;41-47878.0;42-48128.0;37-48378.0;150-48628.0;64-48877.0;42-49127.0;77-49377.0;54-49627.0;100-49877.0;2-50127.0;','2025-01-01 01:00:00',20,0),(43,501957,1668135,0,0,'3-68400.0;67-46149.0;39-46398.0;78-46647.0;53-46896.0;44-47145.0;50-47394.0;60-47643.0;41-47892.0;42-48142.0;37-48391.0;150-48640.0;64-48889.0;42-49138.0;77-49387.0;54-49636.0;100-49885.0;2-50135.0;','2025-01-01 01:00:00',21,0),(11,502583,568365,0,0,'3-68400.0;81-46444.0;50-47228.0;40-48012.0;150-48796.0;100-49580.0;','2025-01-01 01:00:00',22,0),(37,502935,567898,0,0,'3-68400.0;81-46374.0;50-47079.0;40-47784.0;150-48488.0;100-49193.0;2-49898.0;','2025-01-01 01:00:00',23,0),(14,503101,568241,0,0,'3-68400.0;81-46448.0;50-47207.0;40-47965.0;150-48724.0;100-49482.0;2-50241.0;','2025-01-01 01:00:00',24,0),(32,503267,567915,0,0,'3-68400.0;81-46402.0;50-47105.0;40-47807.0;150-48510.0;100-49212.0;2-49915.0;','2025-01-01 01:00:00',25,0),(2,502673,568332,0,0,'3-68400.0;81-46480.0;50-47250.0;40-48021.0;150-48791.0;100-49561.0;2-50332.0;','2025-01-01 01:00:00',26,0),(29,503525,567670,0,0,'3-68400.0;81-46378.0;50-47036.0;40-47695.0;150-48353.0;100-49011.0;2-49670.0;','2025-01-01 01:00:00',27,0),(12,503381,568396,0,0,'3-68400.0;81-46516.0;50-47292.0;40-48068.0;150-48844.0;100-49620.0;2-50396.0;','2025-01-01 01:00:00',28,0),(3,502718,568643,0,0,'3-68400.0;81-46565.0;50-47381.0;40-48196.0;150-49012.0;100-49827.0;2-50643.0;','2025-01-01 01:00:00',29,0),(21,503457,568392,0,0,'3-68400.0;81-46532.0;50-47304.0;40-48076.0;150-48848.0;100-49620.0;2-50392.0;','2025-01-01 01:00:00',30,0),(22,502846,568480,0,0,'3-68400.0;81-46563.0;50-47346.0;40-48130.0;150-48913.0;100-49696.0;2-50480.0;','2025-01-01 01:00:00',31,0),(33,503129,568245,0,0,'3-68400.0;81-46532.0;50-47275.0;40-48017.0;150-48760.0;100-49502.0;2-50245.0;','2025-01-01 01:00:00',32,0),(8,503962,866896,0,0,'3-68400.0;61-46019.0;34-46379.0;50-46738.0;79-47098.0;89-47457.0;150-47817.0;93-48176.0;100-48536.0;2-48896.0;','2025-01-01 01:00:00',33,0),(36,504678,767458,0,0,'3-68400.0;34-46511.0;50-46932.0;79-47353.0;89-47774.0;150-48195.0;93-48616.0;100-49037.0;2-49458.0;','2025-01-01 01:00:00',34,0),(6,504188,867620,0,0,'3-68400.0;61-46117.0;34-46555.0;50-46993.0;79-47431.0;89-47868.0;150-48306.0;93-48744.0;100-49182.0;2-49620.0;','2025-01-01 01:00:00',35,0),(34,504804,867004,0,0,'3-68400.0;61-46067.0;34-46434.0;50-46801.0;79-47168.0;89-47535.0;150-47902.0;93-48269.0;100-48636.0;2-49004.0;','2025-01-01 01:00:00',36,0),(20,504987,867392,0,0,'3-68400.0;61-46119.0;34-46528.0;50-46937.0;79-47346.0;89-47755.0;150-48164.0;93-48573.0;100-48982.0;2-49392.0;','2025-01-01 01:00:00',37,0),(18,504862,867603,0,0,'3-68400.0;61-46151.0;34-46582.0;50-47014.0;79-47445.0;89-47877.0;150-48308.0;93-48740.0;100-49171.0;2-49603.0;','2025-01-01 01:00:00',38,0),(17,504636,866820,0,0,'3-68400.0;61-46073.0;34-46416.0;50-46760.0;79-47103.0;89-47446.0;150-47790.0;93-48133.0;100-48476.0;2-48820.0;','2025-01-01 01:00:00',39,0),(30,503981,867459,0,0,'3-68400.0;61-46162.0;34-46574.0;50-46986.0;79-47398.0;89-47810.0;150-48222.0;93-48634.0;100-49046.0;2-49459.0;','2025-01-01 01:00:00',40,0),(15,504347,867483,0,0,'3-68400.0;61-46173.0;34-46587.0;50-47001.0;79-47414.0;89-47828.0;150-48242.0;93-48655.0;100-49069.0;2-49483.0;','2025-01-01 01:00:00',41,0),(26,504542,866683,0,0,'3-68400.0;61-46093.0;34-46417.0;50-46741.0;79-47064.0;89-47388.0;150-47712.0;93-48035.0;100-48359.0;2-48683.0;','2025-01-01 01:00:00',42,0),(28,504368,867634,0,0,'3-68400.0;61-46208.0;34-46636.0;50-47064.0;79-47492.0;89-47921.0;150-48349.0;93-48777.0;100-49205.0;2-49634.0;','2025-01-01 01:00:00',43,0),(16,504134,866660,0,0,'3-68400.0;61-46117.0;34-46435.0;50-46753.0;79-47071.0;89-47388.0;150-47706.0;93-48024.0;100-48342.0;2-48660.0;','2025-01-01 01:00:00',44,0);
/*!40000 ALTER TABLE `oCard` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oPunch` WRITE;
/*!40000 ALTER TABLE `oPunch` DISABLE KEYS */;
INSERT INTO `oPunch` VALUES (1,2220164,598400,200,200,1225432524,'2025-12-22 23:37:42',1,0),(2,2220164,617970,200,200,299824060,'2025-12-23 00:10:23',2,0),(3,2220164,618700,200,200,418152654,'2025-12-23 00:11:34',3,0);
/*!40000 ALTER TABLE `oPunch` ENABLE KEYS */;
UNLOCK TABLES;
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

LOCK TABLES `oMonitor` WRITE;
/*!40000 ALTER TABLE `oMonitor` DISABLE KEYS */;
INSERT INTO `oMonitor` VALUES (1,'KEMPE',131,'2025-11-04 19:01:32',0,1),(2,'KEMPE',219,'2025-12-21 22:50:54',0,1),(3,'KEMPE',77,'2025-12-21 23:10:40',0,1),(4,'KEMPE',4589,'2025-12-23 23:29:57',0,1),(5,'KEMPE',1,'2025-12-23 23:30:11',0,1),(6,'KEMPE',7,'2026-02-11 18:36:53',0,1),(7,'KEMPE',7457,'2026-02-12 17:33:01',0,0);
/*!40000 ALTER TABLE `oMonitor` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;


-- Fix Card FK for Eva Rådberg (oCard Id=50 is a test artifact not in seed)
UPDATE oRunner SET Card=0 WHERE Id=6;

