-- ============================================================
-- 安全教育互动影游网络版 — 建表 SQL（MySQL 5.7 / InnoDB / utf8mb4）
-- 导入方式：宝塔 phpMyAdmin → 选择 anquan 库 → 导入本文件
-- 设计依据：《安全教育互动影游网络版系统设计文档（Apache+MySQL+PHP版）》第四章
-- 说明：teachers（教师账号）与 game_ending_record（结局流水）为
--       落地实现补充表——文档 3.3 教师登录、3.2.3 多次结局上报需要这两张表。
-- ============================================================

SET NAMES utf8mb4;

-- 4.1 学生表 students
CREATE TABLE IF NOT EXISTS `students` (
  `student_id`   VARCHAR(32)  NOT NULL COMMENT '学生唯一标识',
  `class_name`   VARCHAR(50)  NOT NULL COMMENT '班级名称',
  `student_name` VARCHAR(50)  NOT NULL COMMENT '姓名',
  `phone`        VARCHAR(20)  DEFAULT NULL COMMENT '手机号（可空）',
  `create_time`  DATETIME     NOT NULL COMMENT '首次进入游戏时间',
  PRIMARY KEY (`student_id`),
  KEY `idx_class_name` (`class_name`, `student_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学生表';

-- 补充表：教师账号（设计文档 3.3 教师账号登录）
CREATE TABLE IF NOT EXISTS `teachers` (
  `teacher_id`    VARCHAR(32)  NOT NULL COMMENT '教师唯一标识',
  `account`       VARCHAR(50)  NOT NULL COMMENT '登录账号',
  `password_hash` VARCHAR(255) NOT NULL COMMENT '密码哈希（password_hash）',
  `teacher_name`  VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '教师姓名',
  `is_admin`      TINYINT      NOT NULL DEFAULT 0 COMMENT '1=管理员（可增删教师） / 0=普通教师',
  `create_time`   DATETIME     NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`teacher_id`),
  UNIQUE KEY `uk_account` (`account`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教师表';

-- 4.2 班级表 classes
CREATE TABLE IF NOT EXISTS `classes` (
  `class_id`    VARCHAR(32) NOT NULL COMMENT '班级编号',
  `teacher_id`  VARCHAR(32) NOT NULL COMMENT '所属教师',
  `class_name`  VARCHAR(50) NOT NULL COMMENT '班级名称',
  `create_time` DATETIME    NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`class_id`),
  KEY `idx_teacher` (`teacher_id`),
  CONSTRAINT `fk_class_teacher` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`teacher_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='班级表';

-- 4.3 班级学生关联表 class_student_rel（多对多：一人可属多班）
CREATE TABLE IF NOT EXISTS `class_student_rel` (
  `id`         INT         NOT NULL AUTO_INCREMENT COMMENT '主键',
  `class_id`   VARCHAR(32) NOT NULL COMMENT '班级编号',
  `student_id` VARCHAR(32) NOT NULL COMMENT '学生标识',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_class_student` (`class_id`, `student_id`),
  KEY `idx_student` (`student_id`),
  CONSTRAINT `fk_rel_class`   FOREIGN KEY (`class_id`)   REFERENCES `classes` (`class_id`),
  CONSTRAINT `fk_rel_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='班级学生关联表';

-- 4.4 游戏会话主表 game_sessions
CREATE TABLE IF NOT EXISTS `game_sessions` (
  `record_id`      VARCHAR(32) NOT NULL COMMENT '一次游戏会话标识',
  `student_id`     VARCHAR(32) NOT NULL COMMENT '学生标识',
  `start_time`     DATETIME    NOT NULL COMMENT '会话开始时间',
  `end_time`       DATETIME    DEFAULT NULL COMMENT '会话结束时间',
  `total_cost_sec` INT         DEFAULT NULL COMMENT '总耗时（秒）',
  `is_complete`    TINYINT     DEFAULT NULL COMMENT '0未通关 / 1顺利通关',
  `end_ending_id`  INT         DEFAULT NULL COMMENT '达成结局编号（1-8）',
  PRIMARY KEY (`record_id`),
  KEY `idx_student` (`student_id`),
  CONSTRAINT `fk_sess_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`student_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='游戏会话主表';

-- 4.5 节点轨迹流水表 game_node_trace
CREATE TABLE IF NOT EXISTS `game_node_trace` (
  `trace_id`    VARCHAR(32) NOT NULL COMMENT '轨迹标识',
  `record_id`   VARCHAR(32) NOT NULL COMMENT '会话标识',
  `node_id`     INT         NOT NULL COMMENT '故事节点编号（1-19）',
  `choice_id`   INT         DEFAULT NULL COMMENT '分支选择编号',
  `node_title`  VARCHAR(80) DEFAULT NULL COMMENT '节点中文名称（冗余存储，便于后台展示）',
  `choice_text` VARCHAR(200) DEFAULT NULL COMMENT '所选选项原文（冗余存储，便于后台展示）',
  `enter_time`  DATETIME    NOT NULL COMMENT '进入节点时间',
  PRIMARY KEY (`trace_id`),
  KEY `idx_record` (`record_id`, `enter_time`),
  CONSTRAINT `fk_trace_record` FOREIGN KEY (`record_id`) REFERENCES `game_sessions` (`record_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='节点轨迹流水表';

-- 4.6 死循环记录表 game_loop_record
CREATE TABLE IF NOT EXISTS `game_loop_record` (
  `loop_id`         VARCHAR(32) NOT NULL COMMENT '记录标识',
  `record_id`       VARCHAR(32) NOT NULL COMMENT '会话标识',
  `loop_node_id`    INT         NOT NULL COMMENT '死循环节点编号',
  `enter_count`     INT         NOT NULL DEFAULT 1 COMMENT '累计进入次数',
  `last_enter_time` DATETIME    NOT NULL COMMENT '最后一次进入时间',
  PRIMARY KEY (`loop_id`),
  UNIQUE KEY `uk_record_loop` (`record_id`, `loop_node_id`),
  CONSTRAINT `fk_loop_record` FOREIGN KEY (`record_id`) REFERENCES `game_sessions` (`record_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='死循环记录表';

-- 4.7 QTE 动作记录表 game_qte_record
CREATE TABLE IF NOT EXISTS `game_qte_record` (
  `qte_id`        VARCHAR(32) NOT NULL COMMENT '记录标识',
  `record_id`     VARCHAR(32) NOT NULL COMMENT '会话标识',
  `qte_name`      VARCHAR(50) NOT NULL COMMENT 'QTE 动作名称',
  `qte_type`      VARCHAR(20) NOT NULL COMMENT '动作类型（点击/长按/滑动/拖拽/答题/限时选择/安全区）',
  `is_success`    TINYINT     NOT NULL COMMENT '0失败 / 1成功',
  `cost_ms`       INT         NOT NULL DEFAULT 0 COMMENT '单次完成用时（毫秒）',
  `attempt_count` INT         NOT NULL DEFAULT 1 COMMENT '尝试次数',
  `occur_time`    DATETIME    NOT NULL COMMENT '动作发生时间',
  PRIMARY KEY (`qte_id`),
  KEY `idx_record` (`record_id`, `occur_time`),
  CONSTRAINT `fk_qte_record` FOREIGN KEY (`record_id`) REFERENCES `game_sessions` (`record_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='QTE动作记录表';

-- 补充表：结局流水（设计文档 3.2.3：抵达任意结局页面即上报，可多次达成）
CREATE TABLE IF NOT EXISTS `game_ending_record` (
  `id`          INT         NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `record_id`   VARCHAR(32) NOT NULL COMMENT '会话标识',
  `ending_id`   INT         NOT NULL COMMENT '结局编号（1-8）',
  `ending_type` VARCHAR(20) NOT NULL DEFAULT '' COMMENT '结局类型 good/normal/bad',
  `occur_time`  DATETIME    NOT NULL COMMENT '达成时间',
  PRIMARY KEY (`id`),
  KEY `idx_record` (`record_id`),
  CONSTRAINT `fk_end_record` FOREIGN KEY (`record_id`) REFERENCES `game_sessions` (`record_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='结局记录表';

-- ============================================================
-- 初始数据：测试教师账号（同时是管理员，可在后台继续添加教师）
--   账号 teacher1  密码 wstx@123 （bcrypt 哈希，登录后请在后台尽快改密）
-- ============================================================
INSERT INTO `teachers` (`teacher_id`, `account`, `password_hash`, `teacher_name`, `is_admin`, `create_time`)
VALUES ('t_demo01', 'teacher1', '$2y$10$.33lzqjxMh69qxLa1F1GvOiwtJh5SXWZpX7TbwyWH3w8XYYrtmwau', '测试教师', 1, NOW())
ON DUPLICATE KEY UPDATE `account` = `account`;
