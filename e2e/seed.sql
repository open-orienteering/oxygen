-- MySQL dump 10.13  Distrib 8.0.45, for Linux (x86_64)
--
-- Host: localhost    Database: itest
-- ------------------------------------------------------
-- Server version	8.0.45-0ubuntu0.22.04.1

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

--
-- Table structure for table `oCard`
--

DROP TABLE IF EXISTS `oCard`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oCard` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `CardNo` int NOT NULL DEFAULT '0',
  `ReadId` int unsigned NOT NULL DEFAULT '0',
  `Voltage` int unsigned NOT NULL DEFAULT '0',
  `BDate` int NOT NULL DEFAULT '0',
  `Punches` varchar(3040) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oCard_Counter_idx` (`Counter`),
  KEY `oCard_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=45 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oCard`
--

LOCK TABLES `oCard` WRITE;
/*!40000 ALTER TABLE `oCard` DISABLE KEYS */;
INSERT INTO `oCard` VALUES (1,500319,0,0,0,'3-36000.0;67-13704.0;39-13948.0;78-14192.0;53-14436.0;44-14680.0;50-14925.0;60-15169.0;41-15413.0;42-15657.0;37-15901.0;150-16145.0;64-16390.0;42-16634.0;77-16878.0;54-17122.0;100-17366.0;2-17611.0;','2026-03-25 03:22:21',0,0),(2,502673,0,0,0,'3-36000.0;81-14080.0;50-14850.0;40-15621.0;150-16391.0;100-17161.0;2-17932.0;','2026-03-25 03:22:21',0,0),(3,502718,0,0,0,'3-36000.0;81-14165.0;50-14981.0;40-15796.0;150-16612.0;100-17427.0;2-18243.0;','2026-03-25 03:22:21',0,0),(4,500196,0,0,0,'3-36000.0;67-13635.0;39-13911.0;78-14186.0;53-14462.0;44-14738.0;50-15013.0;60-15289.0;41-15565.0;42-15840.0;37-16116.0;150-16392.0;64-16667.0;42-16943.0;77-17219.0;54-17494.0;100-17770.0;2-18046.0;','2026-03-25 03:22:21',0,0),(5,501061,0,0,0,'3-36000.0;67-13526.0;39-13772.0;78-14018.0;53-14264.0;44-14510.0;50-14756.0;60-15002.0;41-15248.0;42-15494.0;37-15740.0;150-15986.0;64-16232.0;42-16478.0;77-16724.0;54-16970.0;100-17216.0;2-17463.0;','2026-03-25 03:22:21',0,0),(6,504188,0,0,0,'3-36000.0;61-13717.0;34-14155.0;50-14593.0;79-15031.0;89-15468.0;150-15906.0;93-16344.0;100-16782.0;2-17220.0;','2026-03-25 03:22:21',0,0),(7,500944,0,0,0,'3-36000.0;67-13601.0;78-14123.0;53-14384.0;44-14645.0;50-14906.0;60-15167.0;41-15428.0;42-15689.0;37-15950.0;150-16211.0;64-16472.0;42-16733.0;54-17255.0;100-17516.0;2-17777.0;','2026-03-25 03:22:21',0,0),(8,503962,0,0,0,'3-36000.0;61-13619.0;34-13979.0;50-14338.0;79-14698.0;89-15057.0;150-15417.0;93-15776.0;100-16136.0;2-16496.0;','2026-03-25 03:22:21',0,0),(9,501259,0,0,0,'3-36000.0;67-13595.0;39-13870.0;78-14145.0;53-14420.0;44-14695.0;50-14970.0;60-15245.0;41-15520.0;42-15796.0;37-16071.0;150-16346.0;64-16621.0;42-16896.0;77-17171.0;54-17446.0;100-17721.0;2-17997.0;','2026-03-25 03:22:21',0,0),(10,500699,0,0,0,'3-36000.0;67-13716.0;39-13982.0;78-14248.0;53-14514.0;44-14780.0;50-15046.0;60-15312.0;41-15578.0;42-15844.0;37-16110.0;150-16376.0;64-16642.0;42-16908.0;77-17174.0;54-17440.0;100-17706.0;2-17973.0;','2026-03-25 03:22:21',0,0),(11,502583,0,0,0,'3-36000.0;81-14044.0;50-14828.0;40-15612.0;150-16396.0;100-17180.0;','2026-03-25 03:22:21',0,0),(12,503381,0,0,0,'3-36000.0;81-14116.0;50-14892.0;40-15668.0;150-16444.0;100-17220.0;2-17996.0;','2026-03-25 03:22:21',0,0),(13,501438,0,0,0,'','2026-03-25 03:22:21',0,0),(14,503101,0,0,0,'3-36000.0;81-14048.0;50-14807.0;40-15565.0;150-16324.0;100-17082.0;2-17841.0;','2026-03-25 03:22:21',0,0),(15,504347,0,0,0,'3-36000.0;61-13773.0;34-14187.0;50-14601.0;79-15014.0;89-15428.0;150-15842.0;93-16255.0;100-16669.0;2-17083.0;','2026-03-25 03:22:21',0,0),(16,504134,0,0,0,'3-36000.0;61-13717.0;34-14035.0;50-14353.0;79-14671.0;89-14988.0;150-15306.0;93-15624.0;100-15942.0;2-16260.0;','2026-03-25 03:22:21',0,0),(17,504636,0,0,0,'3-36000.0;61-13673.0;34-14016.0;50-14360.0;79-14703.0;89-15046.0;150-15390.0;93-15733.0;100-16076.0;2-16420.0;','2026-03-25 03:22:21',0,0),(18,504862,0,0,0,'3-36000.0;61-13751.0;34-14182.0;50-14614.0;79-15045.0;89-15477.0;150-15908.0;93-16340.0;100-16771.0;2-17203.0;','2026-03-25 03:22:21',0,0),(19,501162,0,0,0,'3-36000.0;67-13599.0;39-13868.0;78-14137.0;53-14407.0;44-14676.0;50-14945.0;60-15215.0;41-15484.0;42-15753.0;37-16022.0;150-16292.0;64-16561.0;42-16830.0;77-17100.0;54-17369.0;100-17638.0;','2026-03-25 03:22:21',0,0),(20,504987,0,0,0,'3-36000.0;61-13719.0;34-14128.0;50-14537.0;79-14946.0;89-15355.0;150-15764.0;93-16173.0;100-16582.0;2-16992.0;','2026-03-25 03:22:21',0,0),(21,503457,0,0,0,'3-36000.0;81-14132.0;50-14904.0;40-15676.0;150-16448.0;100-17220.0;2-17992.0;','2026-03-25 03:22:21',0,0),(22,502846,0,0,0,'3-36000.0;81-14163.0;50-14946.0;40-15730.0;150-16513.0;100-17296.0;2-18080.0;','2026-03-25 03:22:21',0,0),(23,501685,0,0,0,'3-36000.0;67-13690.0;39-13971.0;78-14251.0;53-14532.0;44-14812.0;50-15093.0;60-15373.0;41-15654.0;42-15934.0;37-16215.0;150-16495.0;64-16776.0;42-17056.0;77-17337.0;54-17617.0;100-17898.0;2-18179.0;','2026-03-25 03:22:21',0,0),(24,502118,0,0,0,'3-36000.0;67-13555.0;39-13810.0;78-14066.0;53-14321.0;44-14577.0;50-14832.0;60-15088.0;41-15343.0;42-15599.0;37-15854.0;150-16110.0;64-16365.0;42-16621.0;77-16876.0;54-17132.0;100-17387.0;2-17643.0;','2026-03-25 03:22:21',0,0),(25,500188,0,0,0,'3-36000.0;67-13758.0;39-14047.0;78-14336.0;53-14625.0;44-14913.0;50-15202.0;60-15491.0;41-15780.0;42-16068.0;37-16357.0;150-16646.0;64-16935.0;42-17223.0;77-17512.0;54-17801.0;100-18090.0;2-18379.0;','2026-03-25 03:22:21',0,0),(26,504542,0,0,0,'3-36000.0;61-13693.0;34-14017.0;50-14341.0;79-14664.0;89-14988.0;150-15312.0;93-15635.0;100-15959.0;2-16283.0;','2026-03-25 03:22:21',0,0),(27,500803,0,0,0,'3-36000.0;67-13529.0;39-13798.0;78-14067.0;53-14336.0;44-14605.0;60-15143.0;41-15412.0;42-15682.0;37-15951.0;150-16220.0;64-16489.0;42-16758.0;77-17027.0;54-17296.0;100-17565.0;2-17835.0;','2026-03-25 03:22:21',0,0),(28,504368,0,0,0,'3-36000.0;61-13808.0;34-14236.0;50-14664.0;79-15092.0;89-15521.0;150-15949.0;93-16377.0;100-16805.0;2-17234.0;','2026-03-25 03:22:21',0,0),(29,503525,0,0,0,'3-36000.0;81-13978.0;50-14636.0;40-15295.0;150-15953.0;100-16611.0;2-17270.0;','2026-03-25 03:22:21',0,0),(30,503981,0,0,0,'3-36000.0;61-13762.0;34-14174.0;50-14586.0;79-14998.0;89-15410.0;150-15822.0;93-16234.0;100-16646.0;2-17059.0;','2026-03-25 03:22:21',0,0),(31,500416,0,0,0,'3-36000.0;67-13672.0;39-13965.0;78-14258.0;53-14551.0;44-14844.0;50-15137.0;60-15430.0;41-15723.0;42-16015.0;37-16308.0;150-16601.0;64-16894.0;42-17187.0;77-17480.0;54-17773.0;100-18066.0;2-18359.0;','2026-03-25 03:22:21',0,0),(32,503267,0,0,0,'3-36000.0;81-14002.0;50-14705.0;40-15407.0;150-16110.0;100-16812.0;2-17515.0;','2026-03-25 03:22:21',0,0),(33,503129,0,0,0,'3-36000.0;81-14132.0;50-14875.0;40-15617.0;150-16360.0;100-17102.0;2-17845.0;','2026-03-25 03:22:21',0,0),(34,504804,0,0,0,'3-36000.0;61-13667.0;34-14034.0;50-14401.0;79-14768.0;89-15135.0;150-15502.0;93-15869.0;100-16236.0;2-16604.0;','2026-03-25 03:22:21',0,0),(35,501588,0,0,0,'3-36000.0;67-13670.0;39-13911.0;78-14152.0;53-14392.0;44-14633.0;50-14874.0;60-15114.0;41-15355.0;42-15596.0;37-15837.0;150-16077.0;64-16318.0;42-16559.0;77-16799.0;54-17040.0;100-17281.0;2-17522.0;','2026-03-25 03:22:21',0,0),(36,504678,0,0,0,'3-36000.0;34-14111.0;50-14532.0;79-14953.0;89-15374.0;150-15795.0;93-16216.0;100-16637.0;2-17058.0;','2026-03-25 03:22:21',0,0),(37,502935,0,0,0,'3-36000.0;81-13974.0;50-14679.0;40-15384.0;150-16088.0;100-16793.0;2-17498.0;','2026-03-25 03:22:21',0,0),(38,501320,0,0,0,'3-36000.0;67-13729.0;39-13979.0;78-14229.0;53-14479.0;44-14729.0;50-14978.0;60-15228.0;41-15478.0;42-15728.0;37-15978.0;150-16228.0;64-16477.0;42-16727.0;77-16977.0;54-17227.0;100-17477.0;2-17727.0;','2026-03-25 03:22:21',0,0),(39,500545,0,0,0,'3-36000.0;67-13726.0;39-14013.0;78-14300.0;53-14587.0;44-14874.0;50-15161.0;60-15448.0;41-15735.0;42-16022.0;37-16309.0;150-16596.0;64-16883.0;42-17170.0;77-17457.0;54-17744.0;100-18031.0;2-18318.0;','2026-03-25 03:22:21',0,0),(40,501524,0,0,0,'3-36000.0;67-13683.0;39-13946.0;78-14209.0;53-14472.0;44-14735.0;50-14998.0;60-15261.0;41-15524.0;42-15787.0;37-16050.0;150-16313.0;64-16576.0;42-16839.0;77-17102.0;54-17365.0;100-17628.0;2-17892.0;','2026-03-25 03:22:21',0,0),(41,502141,0,0,0,'3-36000.0;67-13532.0;39-13774.0;78-14016.0;53-14258.0;44-14501.0;50-14743.0;60-14985.0;41-15227.0;42-15470.0;37-15712.0;150-15954.0;64-16196.0;42-16439.0;77-16681.0;54-16923.0;100-17165.0;2-17408.0;','2026-03-25 03:22:21',0,0),(42,501807,0,0,0,'3-36000.0;67-13660.0;39-13950.0;78-14240.0;53-14531.0;44-14821.0;50-15111.0;60-15402.0;41-15692.0;42-15982.0;37-16272.0;150-16563.0;64-16853.0;42-17143.0;77-17434.0;54-17724.0;100-18014.0;2-18305.0;','2026-03-25 03:22:21',0,0),(43,501957,0,0,0,'3-36000.0;67-13749.0;39-13998.0;78-14247.0;53-14496.0;44-14745.0;50-14994.0;60-15243.0;41-15492.0;42-15742.0;37-15991.0;150-16240.0;64-16489.0;42-16738.0;77-16987.0;54-17236.0;100-17485.0;2-17735.0;','2026-03-25 03:22:21',0,0),(44,501929,0,0,0,'3-36000.0;67-13645.0;39-13941.0;78-14236.0;53-14532.0;44-14827.0;60-15418.0;41-15714.0;42-16009.0;37-16305.0;150-16600.0;64-16896.0;42-17191.0;77-17487.0;54-17782.0;100-18078.0;2-18374.0;','2026-03-25 03:22:21',0,0);
/*!40000 ALTER TABLE `oCard` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oClass`
--

DROP TABLE IF EXISTS `oClass`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oClass` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Course` int NOT NULL DEFAULT '0',
  `MultiCourse` mediumtext COLLATE utf8mb4_unicode_ci,
  `LegMethod` varchar(1024) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `LongName` varchar(65) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `LowAge` tinyint unsigned NOT NULL DEFAULT '0',
  `HighAge` tinyint unsigned NOT NULL DEFAULT '0',
  `HasPool` tinyint unsigned NOT NULL DEFAULT '0',
  `AllowQuickEntry` tinyint unsigned NOT NULL DEFAULT '0',
  `ClassType` varchar(81) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Sex` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `StartName` varchar(33) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
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
  `Status` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `DirectResult` tinyint NOT NULL DEFAULT '0',
  `Bib` varchar(17) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `BibMode` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Unordered` tinyint unsigned NOT NULL DEFAULT '0',
  `Heat` tinyint unsigned NOT NULL DEFAULT '0',
  `Locked` tinyint unsigned NOT NULL DEFAULT '0',
  `Qualification` mediumtext COLLATE utf8mb4_unicode_ci,
  `NumberMaps` smallint NOT NULL DEFAULT '0',
  `Result` varchar(49) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `TransferFlags` int NOT NULL DEFAULT '0',
  `SplitPrint` varchar(81) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oClass_Counter_idx` (`Counter`),
  KEY `oClass_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oClass`
--

LOCK TABLES `oClass` WRITE;
/*!40000 ALTER TABLE `oClass` DISABLE KEYS */;
INSERT INTO `oClass` VALUES (1,'Öppen 1',1,NULL,'',0,'',0,0,0,1,'Open','','',1,0,0,0,0,0,0,0,0,110,165,0,70,105,0,10,0,'',0,'','',0,0,0,NULL,0,'',0,'',0,0,'','2026-03-25 03:22:21',0,0),(2,'Öppen 2',2,NULL,'',0,'',0,0,0,1,'Open','','',0,0,0,0,0,0,0,0,0,110,165,0,70,105,0,20,0,'',0,'','',0,0,0,NULL,0,'',0,'',0,0,'','2026-03-25 03:22:21',0,0),(3,'Öppen 3',3,NULL,'',0,'',0,0,0,1,'Open','','',0,0,0,0,0,0,0,0,0,110,165,0,70,105,0,30,0,'',0,'','',0,0,0,NULL,0,'',0,'',0,0,'','2026-03-25 03:22:21',0,0);
/*!40000 ALTER TABLE `oClass` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oClub`
--

DROP TABLE IF EXISTS `oClub`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oClub` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `District` int NOT NULL DEFAULT '0',
  `ShortName` varchar(17) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `CareOf` varchar(63) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Street` varchar(83) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `City` varchar(47) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `State` varchar(47) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `ZIP` varchar(23) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `EMail` varchar(129) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Phone` varchar(65) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Nationality` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Country` varchar(47) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Type` varchar(41) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `Invoice` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `InvoiceNo` smallint unsigned NOT NULL DEFAULT '0',
  `StartGroup` int NOT NULL DEFAULT '0',
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oClub_Counter_idx` (`Counter`),
  KEY `oClub_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=888888889 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oClub`
--

LOCK TABLES `oClub` WRITE;
/*!40000 ALTER TABLE `oClub` DISABLE KEYS */;
INSERT INTO `oClub` VALUES (1,'Degerfors OK',18,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(2,'Ankarsrums OK',14,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(3,'Bodafors OK',14,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(4,'Burseryds IF',14,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(5,'Domnarvets GOIF',3,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(6,'Gamleby OK',14,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(7,'Grangärde OK',3,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(8,'Halmstad OK',7,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(9,'Hedesunda IF',5,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(10,'OK Forsarna',9,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(11,'Hultsfreds OK',14,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(12,'Häverödals SK',17,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(13,'IFK Kiruna',11,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(14,'K 3 IF',20,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(15,'Kjula IF',16,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(16,'Krokeks OK',23,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(17,'Laxå OK',12,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(18,'Ljusne-Ala OK',8,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(20,'Niilivaara IS',11,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(21,'Nyköpings OK',16,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(22,'Robertsfors IK',19,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(23,'OK Roto',2,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(24,'Sigtuna OK',17,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(25,'Skellefteå OK',19,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(26,'FK Snapphanarna',13,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(28,'IK Surd',6,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(30,'OK Tranan',20,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0),(888888888,'Vacant',0,'','','','','','','','','','','',0,'',0,0,'2026-03-25 03:22:20',0,0);
/*!40000 ALTER TABLE `oClub` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oControl`
--

DROP TABLE IF EXISTS `oControl`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oControl` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Numbers` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
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
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oControl_Counter_idx` (`Counter`),
  KEY `oControl_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=201 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oControl`
--

LOCK TABLES `oControl` WRITE;
/*!40000 ALTER TABLE `oControl` DISABLE KEYS */;
INSERT INTO `oControl` VALUES (34,'','34',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(37,'','37',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(39,'','39',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(40,'','40',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(41,'','41',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(42,'','42',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(44,'','44',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(50,'Radio 1','50',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(53,'','53',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(54,'','54',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(60,'','60',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(61,'','61',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(64,'','64',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(67,'','67',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(77,'','77',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(78,'','78',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(79,'','79',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(81,'','81',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(89,'','89',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(93,'','93',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(100,'Förvarning','100',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(150,'Radio 2','150',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(200,'Pre-start','200',0,0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0);
/*!40000 ALTER TABLE `oControl` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oCounter`
--

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
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`CounterId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oCounter`
--

LOCK TABLES `oCounter` WRITE;
/*!40000 ALTER TABLE `oCounter` DISABLE KEYS */;
/*!40000 ALTER TABLE `oCounter` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oCourse`
--

DROP TABLE IF EXISTS `oCourse`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oCourse` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Controls` varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Length` int unsigned NOT NULL DEFAULT '0',
  `Legs` varchar(1024) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `NumberMaps` smallint NOT NULL DEFAULT '0',
  `StartName` varchar(33) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Climb` smallint NOT NULL DEFAULT '0',
  `RPointLimit` int NOT NULL DEFAULT '0',
  `RTimeLimit` int NOT NULL DEFAULT '0',
  `RReduction` int NOT NULL DEFAULT '0',
  `RReductionMethod` tinyint unsigned NOT NULL DEFAULT '0',
  `FirstAsStart` tinyint unsigned NOT NULL DEFAULT '0',
  `LastAsFinish` tinyint unsigned NOT NULL DEFAULT '0',
  `CControl` smallint unsigned NOT NULL DEFAULT '0',
  `Shorten` int NOT NULL DEFAULT '0',
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oCourse_Counter_idx` (`Counter`),
  KEY `oCourse_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oCourse`
--

LOCK TABLES `oCourse` WRITE;
/*!40000 ALTER TABLE `oCourse` DISABLE KEYS */;
INSERT INTO `oCourse` VALUES (1,'Bana 1','67;39;78;53;44;50;60;41;42;37;150;64;42;77;54;100;',7340,'',30,'',0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:20',0,0),(2,'Bana 2','81;50;40;150;100;',7060,'',30,'',0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:21',0,0),(3,'Bana 3','61;34;50;79;89;150;93;100;',3400,'',30,'',0,0,0,0,0,0,0,0,0,'2026-03-25 03:22:21',0,0);
/*!40000 ALTER TABLE `oCourse` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oEvent`
--

DROP TABLE IF EXISTS `oEvent`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oEvent` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Annotation` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Date` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ZeroTime` int unsigned NOT NULL DEFAULT '0',
  `NameId` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `BuildVersion` int unsigned NOT NULL DEFAULT '0',
  `CardFee` int NOT NULL DEFAULT '0',
  `EliteFee` int NOT NULL DEFAULT '0',
  `EntryFee` int NOT NULL DEFAULT '0',
  `YouthFee` int NOT NULL DEFAULT '0',
  `YouthAge` tinyint unsigned NOT NULL DEFAULT '0',
  `SeniorAge` tinyint unsigned NOT NULL DEFAULT '0',
  `Account` varchar(61) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Organizer` mediumtext COLLATE utf8mb4_unicode_ci,
  `EMail` mediumtext COLLATE utf8mb4_unicode_ci,
  `Homepage` mediumtext COLLATE utf8mb4_unicode_ci,
  `Phone` varchar(65) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `UseEconomy` tinyint unsigned NOT NULL DEFAULT '0',
  `UseSpeaker` tinyint unsigned NOT NULL DEFAULT '0',
  `MaxTime` int NOT NULL DEFAULT '0',
  `NumStages` tinyint NOT NULL DEFAULT '0',
  `LongTimes` tinyint unsigned NOT NULL DEFAULT '0',
  `SubSeconds` tinyint unsigned NOT NULL DEFAULT '0',
  `Lists` mediumtext COLLATE utf8mb4_unicode_ci,
  `Machine` mediumtext COLLATE utf8mb4_unicode_ci,
  `Features` mediumtext COLLATE utf8mb4_unicode_ci,
  `SPExtra` mediumtext COLLATE utf8mb4_unicode_ci,
  `IVExtra` mediumtext COLLATE utf8mb4_unicode_ci,
  `EntryExtra` mediumtext COLLATE utf8mb4_unicode_ci,
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  `PaymentDue` int NOT NULL DEFAULT '0',
  `OrdinaryEntry` int NOT NULL DEFAULT '0',
  `SecondEntryDate` int NOT NULL DEFAULT '0',
  `LateEntryFactor` varchar(13) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `SecondEntryFactor` varchar(13) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `CareOf` varchar(63) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Street` varchar(65) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Address` varchar(65) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `SkipRunnerDb` tinyint unsigned NOT NULL DEFAULT '0',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `DiffTime` int NOT NULL DEFAULT '0',
  `PreEvent` varchar(129) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `PostEvent` varchar(129) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `ImportStamp` varchar(29) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `EventNumber` tinyint NOT NULL DEFAULT '0',
  `CurrencyFactor` smallint NOT NULL DEFAULT '0',
  `CurrencySymbol` varchar(11) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `CurrencySeparator` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `CurrencyPreSymbol` tinyint NOT NULL DEFAULT '0',
  `CurrencyCode` varchar(11) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `UTC` tinyint NOT NULL DEFAULT '0',
  `Analysis` tinyint NOT NULL DEFAULT '0',
  `BibGap` tinyint unsigned NOT NULL DEFAULT '0',
  `BibsPerClass` tinyint unsigned NOT NULL DEFAULT '0',
  `PayModes` mediumtext COLLATE utf8mb4_unicode_ci,
  `TransferFlags` int NOT NULL DEFAULT '0',
  `InvoiceDate` int NOT NULL DEFAULT '0',
  `StartGroups` mediumtext COLLATE utf8mb4_unicode_ci,
  `MergeTag` varchar(25) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `MergeInfo` mediumtext COLLATE utf8mb4_unicode_ci,
  `SplitPrint` varchar(81) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `NoVacantBib` tinyint unsigned NOT NULL DEFAULT '0',
  `RunnerIdTypes` mediumtext COLLATE utf8mb4_unicode_ci,
  `ExtraFields` mediumtext COLLATE utf8mb4_unicode_ci,
  `ControlMap` mediumtext COLLATE utf8mb4_unicode_ci,
  `OldCards` tinyint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oEvent_Counter_idx` (`Counter`),
  KEY `oEvent_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oEvent`
--

LOCK TABLES `oEvent` WRITE;
/*!40000 ALTER TABLE `oEvent` DISABLE KEYS */;
INSERT INTO `oEvent` VALUES (1,'My example tävling','','2026-04-15',324000,'itest',0,0,0,0,0,0,0,'',NULL,NULL,NULL,'',0,0,0,0,0,0,NULL,NULL,NULL,NULL,NULL,NULL,'2026-03-25 03:22:21',0,0,0,0,0,'','','','','',0,0,0,'','','',0,0,'','',0,'',0,0,0,0,NULL,0,0,NULL,'',NULL,'',0,NULL,NULL,NULL,0);
/*!40000 ALTER TABLE `oEvent` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oMonitor`
--

DROP TABLE IF EXISTS `oMonitor`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oMonitor` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Client` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Count` int unsigned NOT NULL DEFAULT '0',
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oMonitor_Counter_idx` (`Counter`),
  KEY `oMonitor_Modified_idx` (`Modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oMonitor`
--

LOCK TABLES `oMonitor` WRITE;
/*!40000 ALTER TABLE `oMonitor` DISABLE KEYS */;
/*!40000 ALTER TABLE `oMonitor` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oPunch`
--

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
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oPunch_Counter_idx` (`Counter`),
  KEY `oPunch_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oPunch`
--

LOCK TABLES `oPunch` WRITE;
/*!40000 ALTER TABLE `oPunch` DISABLE KEYS */;
INSERT INTO `oPunch` VALUES (1,2220164,274400,200,200,1225432524,'2026-03-25 03:22:21',0,0),(2,2220164,293970,200,200,299824060,'2026-03-25 03:22:21',0,0),(3,2220164,294700,200,200,418152654,'2026-03-25 03:22:21',0,0);
/*!40000 ALTER TABLE `oPunch` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oRunner`
--

DROP TABLE IF EXISTS `oRunner`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oRunner` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `CardNo` int NOT NULL DEFAULT '0',
  `Club` int NOT NULL DEFAULT '0',
  `Class` int NOT NULL DEFAULT '0',
  `Course` int NOT NULL DEFAULT '0',
  `StartNo` int NOT NULL DEFAULT '0',
  `StartTime` int NOT NULL DEFAULT '0',
  `FinishTime` int NOT NULL DEFAULT '0',
  `Status` int NOT NULL DEFAULT '0',
  `Card` int NOT NULL DEFAULT '0',
  `MultiR` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
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
  `Bib` varchar(17) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Rank` int NOT NULL DEFAULT '0',
  `Sex` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Nationality` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Country` varchar(47) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Phone` varchar(41) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `EntryDate` int NOT NULL DEFAULT '0',
  `EntryTime` int NOT NULL DEFAULT '0',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `ExtId2` bigint NOT NULL DEFAULT '0',
  `Priority` tinyint unsigned NOT NULL DEFAULT '0',
  `RaceId` int NOT NULL DEFAULT '0',
  `TimeAdjust` int NOT NULL DEFAULT '0',
  `PointAdjust` int NOT NULL DEFAULT '0',
  `TransferFlags` int NOT NULL DEFAULT '0',
  `Shorten` tinyint unsigned NOT NULL DEFAULT '0',
  `EntrySource` int NOT NULL DEFAULT '0',
  `Heat` tinyint unsigned NOT NULL DEFAULT '0',
  `Reference` int NOT NULL DEFAULT '0',
  `NoRestart` tinyint unsigned NOT NULL DEFAULT '0',
  `InputResult` mediumtext COLLATE utf8mb4_unicode_ci,
  `StartGroup` int NOT NULL DEFAULT '0',
  `Family` int NOT NULL DEFAULT '0',
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Annotation` mediumtext COLLATE utf8mb4_unicode_ci,
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  `oos_card_returned` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oRunner_Counter_idx` (`Counter`),
  KEY `oRunner_Modified_idx` (`Modified`)
) ENGINE=InnoDB AUTO_INCREMENT=55 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oRunner`
--

LOCK TABLES `oRunner` WRITE;
/*!40000 ALTER TABLE `oRunner` DISABLE KEYS */;
INSERT INTO `oRunner` VALUES (1,'Linda Klick',500188,7,1,0,22,1,183790,1,25,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(2,'Thommie Antonsson',500196,4,1,0,11,1,180460,1,4,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(3,'Annelie Najvik',500319,15,1,0,21,1,176110,1,1,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(4,'Charlotte Olovsson',500416,7,1,0,13,1,183590,1,31,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(5,'Ted Björkman',500545,23,1,0,19,1,183180,1,39,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(6,'Eva Rådberg',500671,25,1,0,14,1,0,0,0,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(7,'Stig Gösswein',500699,4,1,0,20,1,179730,1,10,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(8,'Monica Henriksson',500803,2,1,0,1,132600,178350,3,27,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(9,'Bo-Göran Persson',500944,15,1,0,9,1,177770,3,7,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(10,'Nilsson Collryd',501061,20,1,0,3,1,174630,1,5,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(11,'Magnus Johansson',501162,15,1,0,8,1,0,4,19,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(12,'Helena Bergström',501259,13,1,0,7,1,179970,1,9,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(13,'Tova Askeljung',501320,3,1,0,23,1,177270,1,38,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(14,'Malin Johannesson',501438,16,1,0,2,1,178850,1,13,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(15,'Simon Johansson',501524,21,1,0,17,1,178920,1,40,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(16,'Filip Johansson',501588,9,1,0,18,1,175220,1,35,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(17,'Björn Carlsson',501685,5,1,0,16,1,181790,1,23,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(18,'Monica Johansson',501807,15,1,0,12,1,183050,1,42,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(19,'Gun Karlsson',501929,10,1,0,10,1,183740,3,44,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(20,'Johan Jonsson',501957,15,1,0,25,1,177350,1,43,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(21,'Albin Bergman',2220164,12,1,0,5,1,0,0,0,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(22,'Roger Thörnblom',502141,15,1,0,4,1,174080,1,41,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(23,'Vakant',0,888888888,1,0,24,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(24,'Vakant',0,888888888,1,0,15,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(25,'Vakant',0,888888888,1,0,6,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(26,'Ann Sjödin',502583,15,2,0,1,1,0,4,11,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(27,'Kirsten Nilsson',502673,18,2,0,6,1,179320,1,2,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(28,'Åsa Robertsson',502718,17,2,0,10,1,182430,0,3,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(29,'Gunnar Wickberg',502846,6,2,0,13,1,180800,1,22,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(30,'Stefan Hersén',502935,12,2,0,2,1,174980,1,37,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(31,'Stig Vedin',503101,22,2,0,4,1,178410,1,14,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(32,'Sara Stridfeldt',503129,28,2,0,14,1,178450,1,33,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(33,'Oskar Svensson',503267,8,2,0,5,1,175150,1,32,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(34,'Ewa Fröjd',503381,6,2,0,9,1,179960,1,12,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(35,'Leif Frisell',503457,12,2,0,11,1,179920,1,21,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(36,'Kim Johansson',503525,15,2,0,7,1,172700,1,29,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(37,'Vakant',0,888888888,2,0,3,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(38,'Vakant',0,888888888,2,0,8,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(39,'Vakant',0,888888888,2,0,12,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(40,'Börje Löfgren',503962,9,3,0,1,1,164960,1,8,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(41,'Leif Wallström',503981,3,3,0,10,1,170590,1,30,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(42,'Vanja Engvall',504134,15,3,0,15,1,162600,1,16,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(43,'Ann Thulin',504188,15,3,0,3,1,172200,1,6,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(44,'Hampus Berggren',504347,2,3,0,11,1,170830,1,15,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(45,'Mats Mollén',504368,15,3,0,13,1,172340,1,28,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(46,'Ronny Backman',504542,8,3,0,12,1,162830,1,26,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(47,'Susanne Jansson',504636,15,3,0,8,1,164200,1,17,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(48,'Isabella Johansson',504678,1,3,0,2,1,170580,3,36,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(49,'Hjalmar Enström',504804,30,3,0,5,1,166040,1,34,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(50,'Thomas Hilmersson',504862,21,3,0,7,1,172030,1,18,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(51,'Kristina Pettersson',504987,15,3,0,6,1,169920,1,20,'',0,0,0,0,110,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(52,'Vakant',0,888888888,3,0,4,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(53,'Vakant',0,888888888,3,0,9,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0),(54,'Vakant',0,888888888,3,0,14,1,0,0,0,'',0,0,0,0,0,0,0,0,0,0,'',0,'','','','',20150415,0,0,0,0,0,0,0,0,0,0,0,0,0,NULL,0,0,0,0,'',NULL,'2026-03-25 03:22:21',0,0,0);
/*!40000 ALTER TABLE `oRunner` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oTeam`
--

DROP TABLE IF EXISTS `oTeam`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oTeam` (
  `Id` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Runners` varchar(256) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
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
  `Nationality` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Country` varchar(47) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Bib` varchar(17) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `ExtId` bigint NOT NULL DEFAULT '0',
  `Priority` tinyint unsigned NOT NULL DEFAULT '0',
  `SortIndex` smallint NOT NULL DEFAULT '0',
  `TimeAdjust` int NOT NULL DEFAULT '0',
  `PointAdjust` int NOT NULL DEFAULT '0',
  `TransferFlags` int NOT NULL DEFAULT '0',
  `EntrySource` int NOT NULL DEFAULT '0',
  `Heat` tinyint unsigned NOT NULL DEFAULT '0',
  `NoRestart` tinyint unsigned NOT NULL DEFAULT '0',
  `InputResult` mediumtext COLLATE utf8mb4_unicode_ci,
  `DataA` int NOT NULL DEFAULT '0',
  `DataB` int NOT NULL DEFAULT '0',
  `TextA` varchar(81) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Annotation` mediumtext COLLATE utf8mb4_unicode_ci,
  `Modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Counter` int unsigned NOT NULL DEFAULT '0',
  `Removed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Id`),
  KEY `oTeam_Counter_idx` (`Counter`),
  KEY `oTeam_Modified_idx` (`Modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oTeam`
--

LOCK TABLES `oTeam` WRITE;
/*!40000 ALTER TABLE `oTeam` DISABLE KEYS */;
/*!40000 ALTER TABLE `oTeam` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `oxygen_club_logo`
--

DROP TABLE IF EXISTS `oxygen_club_logo`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oxygen_club_logo` (
  `EventorId` int NOT NULL,
  `SmallPng` mediumblob NOT NULL,
  `LargePng` mediumblob,
  `UpdatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`EventorId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `oxygen_club_logo`
--

LOCK TABLES `oxygen_club_logo` WRITE;
/*!40000 ALTER TABLE `oxygen_club_logo` DISABLE KEYS */;
/*!40000 ALTER TABLE `oxygen_club_logo` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-03-25  5:22:20
