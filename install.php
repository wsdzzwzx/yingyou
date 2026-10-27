<?php
/**
 * 安全教育互动影游网络版 — 一键安装向导
 * ------------------------------------------------------------------
 * 用法：把本文件连同 config.php、db/schema.sql 一起上传到项目根目录，
 *      浏览器访问  http://你的域名/yingyou/anquan/install.php?key=aq-install-2026
 *      看到「安装完成」后，务必删除本文件。
 *
 * 作用：
 *   1. 环境自检（PHP 版本 / pdo_mysql / 目录可读）
 *   2. 建库（若宝塔已建则跳过）+ 建 9 张表 + 写入测试教师账号
 *   3. 强制把 teacher1 的密码重置为 wstx@123（避免哈希不匹配登不进去）
 *   4. 输出表清单与行数，便于核对
 *
 * 安全：必须带 ?key=aq-install-2026 才会执行；不带 key 只显示提示。
 *       重复执行安全（建表用 IF NOT EXISTS，不会清空已有数据）。
 * ------------------------------------------------------------------
 */

/* ============ 安装密钥（如需修改，改这里和访问网址的 key 保持一致） ============ */
define('INSTALL_KEY', 'aq-install-2026');

/* ============ 默认教师账号（安装时写入/重置） ============ */
define('SEED_ACCOUNT', 'teacher1');
define('SEED_PASSWORD', 'wstx@123');
define('SEED_NAME', '测试教师');

/* ==================== 内嵌建表脚本（db/schema.sql 丢失时的兜底） ==================== */
$SCHEMA_FALLBACK = <<<'SQL'
CREATE TABLE IF NOT EXISTS `students` (
  `student_id`   VARCHAR(32)  NOT NULL COMMENT '学生唯一标识',
  `class_name`   VARCHAR(50)  NOT NULL COMMENT '班级名称',
  `student_name` VARCHAR(50)  NOT NULL COMMENT '姓名',
  `phone`        VARCHAR(20)  DEFAULT NULL COMMENT '手机号（可空）',
  `create_time`  DATETIME     NOT NULL COMMENT '首次进入游戏时间',
  PRIMARY KEY (`student_id`),
  KEY `idx_class_name` (`class_name`, `student_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学生表';

CREATE TABLE IF NOT EXISTS `teachers` (
  `teacher_id`    VARCHAR(32)  NOT NULL COMMENT '教师唯一标识',
  `account`       VARCHAR(50)  NOT NULL COMMENT '登录账号',
  `password_hash` VARCHAR(255) NOT NULL COMMENT '密码哈希（password_hash）',
  `teacher_name`  VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '教师姓名',
  `is_admin`      TINYINT      NOT NULL DEFAULT 0 COMMENT '1=管理员 / 0=普通教师',
  `create_time`   DATETIME     NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`teacher_id`),
  UNIQUE KEY `uk_account` (`account`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教师表';

CREATE TABLE IF NOT EXISTS `classes` (
  `class_id`    VARCHAR(32) NOT NULL COMMENT '班级编号',
  `teacher_id`  VARCHAR(32) NOT NULL COMMENT '所属教师',
  `class_name`  VARCHAR(50) NOT NULL COMMENT '班级名称',
  `create_time` DATETIME    NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`class_id`),
  KEY `idx_teacher` (`teacher_id`),
  CONSTRAINT `fk_class_teacher` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`teacher_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='班级表';

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

CREATE TABLE IF NOT EXISTS `game_node_trace` (
  `trace_id`    VARCHAR(32) NOT NULL COMMENT '轨迹标识',
  `record_id`   VARCHAR(32) NOT NULL COMMENT '会话标识',
  `node_id`     INT         NOT NULL COMMENT '故事节点编号（1-19）',
  `choice_id`   INT         DEFAULT NULL COMMENT '分支选择编号',
  `node_title`  VARCHAR(80) DEFAULT NULL COMMENT '节点中文名称',
  `choice_text` VARCHAR(200) DEFAULT NULL COMMENT '所选选项原文',
  `enter_time`  DATETIME    NOT NULL COMMENT '进入节点时间',
  PRIMARY KEY (`trace_id`),
  KEY `idx_record` (`record_id`, `enter_time`),
  CONSTRAINT `fk_trace_record` FOREIGN KEY (`record_id`) REFERENCES `game_sessions` (`record_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='节点轨迹流水表';

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
SQL;


/* ==================== 参数校验 ==================== */
$key = isset($_GET['key']) ? trim($_GET['key']) : '';
/* 带 &keep=1 可跳过「重置测试教师密码」（不想覆盖已改过的密码时用） */
$keepPass = (isset($_GET['keep']) && $_GET['keep'] === '1');
if ($key === '' || $key !== INSTALL_KEY) {
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><title>安装向导</title>';
    echo '<div style="font:16px/1.8 system-ui,sans-serif;max-width:620px;margin:80px auto;padding:28px 32px;'
       . 'border:1px solid #e5e7eb;border-radius:12px;background:#fff;color:#111827">';
    echo '<h2 style="margin:0 0 12px">安装向导未启动</h2>';
    echo '<p>出于安全考虑，需要携带安装密钥才能执行建库建表。</p>';
    echo '<p>请访问：<code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">install.php?key='
       . htmlspecialchars(INSTALL_KEY, ENT_QUOTES) . '</code></p>';
    echo '</div>';
    exit;
}

@set_time_limit(120);
header('Content-Type: text/html; charset=utf-8');

/* ==================== 收集结果 ==================== */
$checks = array();   // 环境自检
$steps  = array();   // 执行步骤
$tables = array();   // 表清单
$fatal  = '';

function add_check(&$arr, $name, $ok, $detail = '')
{
    $arr[] = array('name' => $name, 'ok' => (bool)$ok, 'detail' => $detail);
}

function add_step(&$arr, $name, $ok, $detail = '')
{
    $arr[] = array('name' => $name, 'ok' => (bool)$ok, 'detail' => $detail);
}

/** 把 SQL 文本按分号拆成单条语句（跳过 -- 注释行与空行） */
function split_sql($sql)
{
    $out = array();
    $buf = '';
    $lines = preg_split('/\r\n|\r|\n/', $sql);
    foreach ($lines as $line) {
        $t = ltrim($line);
        if ($t === '' || strpos($t, '--') === 0 || strpos($t, '#') === 0) {
            continue;
        }
        $buf .= $line . "\n";
        if (substr(rtrim($line), -1) === ';') {
            $s = trim($buf);
            if ($s !== '' && $s !== ';') {
                $out[] = rtrim($s, ';');
            }
            $buf = '';
        }
    }
    $s = trim($buf);
    if ($s !== '') {
        $out[] = rtrim($s, ';');
    }
    return $out;
}

/* ==================== 1. 环境自检 ==================== */
add_check($checks, 'PHP 版本 ≥ 5.5', version_compare(PHP_VERSION, '5.5.0', '>='),
    '当前 ' . PHP_VERSION . (version_compare(PHP_VERSION, '7.0.0', '<') ? '（偏旧，建议宝塔切到 7.4）' : ''));

$hasPdoMysql = extension_loaded('pdo_mysql');
add_check($checks, 'PDO MySQL 扩展', $hasPdoMysql, $hasPdoMysql ? '已启用' : '未启用（宝塔 → PHP 设置 → 安装扩展 pdo_mysql）');

$hasSchemaFile = is_file(__DIR__ . '/db/schema.sql');
add_check($checks, 'db/schema.sql 文件', true, $hasSchemaFile ? '已找到，将优先使用' : '未找到，使用脚本内嵌建表语句（不影响安装）');

$hasConfig = is_file(__DIR__ . '/config.php');
add_check($checks, 'config.php 配置', $hasConfig, $hasConfig ? '已找到' : '未找到，使用脚本内默认配置');

/* ==================== 2. 读取配置 ==================== */
$DB_HOST = '127.0.0.1';
$DB_NAME = 'anquan';
$DB_USER = 'anquan';
$DB_PASS = '';
$DB_CHARSET = 'utf8mb4';

if ($hasConfig) {
    $src = file_get_contents(__DIR__ . '/config.php');
    foreach (array('DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'DB_CHARSET') as $c) {
        if (preg_match("/define\('" . $c . "'\s*,\s*'((?:[^'\\\\]|\\\\.)*)'\)/", $src, $m)) {
            $$c = str_replace(array("\\'", '\\\\'), array("'", '\\'), $m[1]);
        }
    }
}

/* ==================== 3. 连接数据库 ==================== */
$pdo = null;
$connErr = '';

if ($hasPdoMysql) {
    // 3.1 先不带库名连接，尝试建库
    try {
        $pdo = new PDO('mysql:host=' . $DB_HOST . ';charset=' . $DB_CHARSET, $DB_USER, $DB_PASS, array(
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 8,
        ));
        add_step($steps, '连接 MySQL 服务', true, $DB_USER . '@' . $DB_HOST);

        try {
            $pdo->exec('CREATE DATABASE IF NOT EXISTS `' . str_replace('`', '', $DB_NAME) . '` '
                . 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
            add_step($steps, '创建数据库 ' . $DB_NAME, true, '已存在或创建成功');
        } catch (Exception $e) {
            add_step($steps, '创建数据库 ' . $DB_NAME, true,
                '账号无建库权限，跳过（宝塔里已建好即可，不影响使用）');
        }

        $pdo->exec('USE `' . str_replace('`', '', $DB_NAME) . '`');
        add_step($steps, '切换到数据库 ' . $DB_NAME, true);
    } catch (Exception $e) {
        $connErr = $e->getMessage();
        $pdo = null;
    }

    // 3.2 直连库名再试一次（部分环境不允许无库连接）
    if ($pdo === null) {
        try {
            $pdo = new PDO('mysql:host=' . $DB_HOST . ';dbname=' . $DB_NAME . ';charset=' . $DB_CHARSET,
                $DB_USER, $DB_PASS, array(
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_TIMEOUT => 8,
                ));
            add_step($steps, '连接数据库 ' . $DB_NAME, true, '直连成功');
        } catch (Exception $e) {
            $pdo = null;
            $connErr = $e->getMessage();
            $fatal = '数据库连接失败：' . $connErr
                . ' —— 请核对 config.php 里的 DB_USER / DB_PASS 与宝塔「数据库」页一致，'
                . '并确认 ' . $DB_NAME . ' 库已创建。';
        }
    }
} else {
    $fatal = 'PHP 未启用 pdo_mysql 扩展，无法建表。请在宝塔 → 软件商店 → PHP 设置 → 安装扩展 中启用 pdo_mysql 后刷新本页。';
}

/* ==================== 4. 建表 ==================== */
if ($pdo !== null) {
    $sqlText = $hasSchemaFile ? file_get_contents(__DIR__ . '/db/schema.sql') : $SCHEMA_FALLBACK;
    if (trim($sqlText) === '') {
        $sqlText = $SCHEMA_FALLBACK;
    }
    $stmts = split_sql($sqlText);
    $okCount = 0;
    $errList = array();
    foreach ($stmts as $s) {
        // 纯 INSERT 交给后面统一处理（避免哈希过期）
        if (stripos(ltrim($s), 'INSERT INTO `teachers`') === 0) {
            continue;
        }
        try {
            $pdo->exec($s);
            $okCount++;
        } catch (Exception $e) {
            $short = preg_replace('/\s+/', ' ', $s);
            if (function_exists('mb_substr')) {
                $short = mb_substr($short, 0, 48, 'UTF-8');
            } else {
                $short = substr($short, 0, 96);
            }
            $errList[] = $short . '… → ' . $e->getMessage();
        }
    }
    add_step($steps, '执行建表语句', count($errList) === 0,
        $okCount . ' 条成功' . (count($errList) ? '，' . count($errList) . ' 条失败' : ''));
    foreach ($errList as $err) {
        add_step($steps, '建表告警', false, $err);
    }

    /* ---- 3.1 老库升级：给轨迹表补上「节点名称 / 选项原文」字段 ----
       已有的库（CREATE TABLE IF NOT EXISTS 不会改结构）需要 ALTER 一次，
       否则后台轨迹只能显示“进入节点 2”，看不到中文名与选项文字。 */
    $alters = array(
        array('node_title', "ALTER TABLE `game_node_trace` ADD COLUMN `node_title` VARCHAR(80) DEFAULT NULL COMMENT '节点中文名称' AFTER `choice_id`"),
        array('choice_text', "ALTER TABLE `game_node_trace` ADD COLUMN `choice_text` VARCHAR(200) DEFAULT NULL COMMENT '所选选项原文' AFTER `node_title`"),
    );
    $added = array();
    $alterErr = array();
    try {
        $cols = $pdo->query('SHOW COLUMNS FROM `game_node_trace`')->fetchAll(PDO::FETCH_COLUMN);
        foreach ($alters as $a) {
            if (!in_array($a[0], $cols, true)) {
                try {
                    $pdo->exec($a[1]);
                    $added[] = $a[0];
                } catch (Exception $e) {
                    $alterErr[] = $a[0] . ' → ' . $e->getMessage();
                }
            }
        }
        add_step($steps, '升级轨迹表字段', count($alterErr) === 0,
            $added ? ('已新增：' . implode('、', $added)) : '字段已齐全，无需变更');
        foreach ($alterErr as $err) {
            add_step($steps, '升级告警', false, $err);
        }
    } catch (Exception $e) {
        add_step($steps, '升级轨迹表字段', false, $e->getMessage() . '（表可能尚未建好）');
    }

    /* ---- 3.2 老库升级：给教师表补上「是否管理员」，并保证至少有 1 个管理员 ----
       多教师后台要求：管理员才能新增/删除教师账号。老库升级后必须有人能管，
       所以把创建时间最早的那位教师设为管理员。 */
    try {
        $tcols = $pdo->query('SHOW COLUMNS FROM `teachers`')->fetchAll(PDO::FETCH_COLUMN);
        $adminAdded = false;
        if (!in_array('is_admin', $tcols, true)) {
            $pdo->exec("ALTER TABLE `teachers` ADD COLUMN `is_admin` TINYINT NOT NULL DEFAULT 0 "
                . "COMMENT '1=管理员 / 0=普通教师' AFTER `teacher_name`");
            $adminAdded = true;
        }
        $nAdmin = (int)$pdo->query('SELECT COUNT(*) FROM `teachers` WHERE `is_admin` = 1')->fetchColumn();
        if ($nAdmin === 0) {
            $first = $pdo->query('SELECT `teacher_id` FROM `teachers` ORDER BY `create_time` ASC, `teacher_id` ASC LIMIT 1')
                ->fetch(PDO::FETCH_COLUMN);
            if ($first) {
                $up = $pdo->prepare('UPDATE `teachers` SET `is_admin` = 1 WHERE `teacher_id` = ?');
                $up->execute(array($first));
                add_step($steps, '设置管理员账号', true, '已将最早创建的教师 ' . $first . ' 设为管理员');
            } else {
                add_step($steps, '设置管理员账号', false, '教师表为空，无法确定管理员（请先创建教师账号）');
            }
        }
        add_step($steps, '升级教师表字段', true,
            $adminAdded ? '已新增 is_admin 字段' : '字段已齐全，无需变更');
    } catch (Exception $e) {
        add_step($steps, '升级教师表字段', false, $e->getMessage() . '（表可能尚未建好）');
    }

    /* ---- 4.1 写入 / 重置测试教师账号（现场生成哈希，保证能登录） ---- */
    if ($keepPass) {
        add_step($steps, '跳过测试教师密码重置', true, '按 keep=1 参数保留现有密码');
    } else {
        try {
            $hash = password_hash(SEED_PASSWORD, PASSWORD_DEFAULT);
            $st = $pdo->prepare('SELECT teacher_id FROM teachers WHERE account = ?');
            $st->execute(array(SEED_ACCOUNT));
            $row = $st->fetch(PDO::FETCH_ASSOC);
            if ($row) {
                $up = $pdo->prepare('UPDATE teachers SET password_hash = ? WHERE account = ?');
                $up->execute(array($hash, SEED_ACCOUNT));
                add_step($steps, '重置测试教师密码', true, SEED_ACCOUNT . ' / ' . SEED_PASSWORD . '（密码哈希已更新）');
            } else {
                $ins = $pdo->prepare('INSERT INTO teachers (teacher_id, account, password_hash, teacher_name, is_admin, create_time)'
                    . ' VALUES (?, ?, ?, ?, 1, NOW())');
                $ins->execute(array('t_demo01', SEED_ACCOUNT, $hash, SEED_NAME));
                add_step($steps, '创建测试教师账号', true, SEED_ACCOUNT . ' / ' . SEED_PASSWORD . '（管理员）');
            }
        } catch (Exception $e) {
            add_step($steps, '写入测试教师账号', false, $e->getMessage());
        }
    }

    /* ---- 4.2 核对表清单与行数 ---- */
    $want = array('students', 'teachers', 'classes', 'class_student_rel',
                  'game_sessions', 'game_node_trace', 'game_loop_record',
                  'game_qte_record', 'game_ending_record');
    try {
        $existRows = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
        $exist = array();
        foreach ($existRows as $t) {
            $exist[$t] = true;
        }
        foreach ($want as $t) {
            if (isset($exist[$t])) {
                $n = (int)$pdo->query('SELECT COUNT(*) FROM `' . $t . '`')->fetchColumn();
                $tables[] = array('name' => $t, 'ok' => true, 'count' => $n);
            } else {
                $tables[] = array('name' => $t, 'ok' => false, 'count' => null);
            }
        }
    } catch (Exception $e) {
        add_step($steps, '读取表清单', false, $e->getMessage());
    }
}

$allTablesOk = count($tables) > 0;
foreach ($tables as $t) {
    if (!$t['ok']) {
        $allTablesOk = false;
    }
}
$success = ($pdo !== null && $allTablesOk && $fatal === '');

/* ==================== 5. 输出页面 ==================== */
function h($s)
{
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}
?>
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>一键安装 · 安全小卫士大闯关</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 16px 64px; background:#f5f7fa; color:#1f2937;
         font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width:860px; margin:0 auto; }
  .card { background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:24px 28px;
          box-shadow:0 2px 10px rgba(15,23,42,.04); margin-bottom:18px; }
  h1 { font-size:24px; margin:0 0 6px; }
  h2 { font-size:17px; margin:0 0 14px; padding-left:10px; border-left:4px solid #2563eb; }
  .lead { color:#6b7280; margin:0 0 4px; }
  .banner { border-radius:12px; padding:18px 22px; margin-bottom:18px; font-weight:600; }
  .banner.ok { background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46; }
  .banner.err { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; }
  ul.rows { list-style:none; margin:0; padding:0; }
  ul.rows li { display:flex; gap:10px; align-items:flex-start; padding:7px 0;
               border-bottom:1px dashed #f1f5f9; }
  ul.rows li:last-child { border-bottom:0; }
  .tag { flex:0 0 auto; width:20px; height:20px; line-height:20px; text-align:center;
         border-radius:50%; font-size:12px; color:#fff; margin-top:3px; }
  .tag.y { background:#10b981; }
  .tag.n { background:#ef4444; }
  .nm { font-weight:600; }
  .dt { color:#6b7280; font-size:13.5px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid #f1f5f9; }
  th { background:#f8fafc; color:#475569; font-weight:600; }
  code { background:#f3f4f6; padding:2px 6px; border-radius:5px; font-size:13.5px; }
  .kv { background:#f8fafc; border:1px solid #e5e7eb; border-radius:10px; padding:14px 16px; }
  .kv b { color:#111827; }
  .warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:10px;
          padding:14px 16px; margin-top:14px; }
  ol.next { margin:0; padding-left:22px; }
  ol.next li { padding:4px 0; }
  a { color:#2563eb; }
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>安全小卫士大闯关 · 一键安装</h1>
    <p class="lead">建库建表 + 写测试教师账号 · 重复执行不会清空已有数据</p>
  </div>

<?php if ($success): ?>
  <div class="banner ok">安装完成：9 张表已就绪，教师账号 <b><?php echo h(SEED_ACCOUNT); ?> / <?php echo h(SEED_PASSWORD); ?></b> 已可登录。</div>
<?php else: ?>
  <div class="banner err">安装未完成<?php echo $fatal !== '' ? '：' . h($fatal) : '，请查看下方失败项。'; ?></div>
<?php endif; ?>

  <div class="card">
    <h2>环境自检</h2>
    <ul class="rows">
      <?php foreach ($checks as $c): ?>
      <li>
        <span class="tag <?php echo $c['ok'] ? 'y' : 'n'; ?>"><?php echo $c['ok'] ? '✓' : '✕'; ?></span>
        <span><span class="nm"><?php echo h($c['name']); ?></span><?php if ($c['detail'] !== ''): ?><br><span class="dt"><?php echo h($c['detail']); ?></span><?php endif; ?></span>
      </li>
      <?php endforeach; ?>
    </ul>
  </div>

  <div class="card">
    <h2>执行过程</h2>
    <?php if (count($steps) === 0): ?>
      <p class="dt">未执行任何步骤。</p>
    <?php else: ?>
    <ul class="rows">
      <?php foreach ($steps as $s): ?>
      <li>
        <span class="tag <?php echo $s['ok'] ? 'y' : 'n'; ?>"><?php echo $s['ok'] ? '✓' : '✕'; ?></span>
        <span><span class="nm"><?php echo h($s['name']); ?></span><?php if ($s['detail'] !== ''): ?><br><span class="dt"><?php echo h($s['detail']); ?></span><?php endif; ?></span>
      </li>
      <?php endforeach; ?>
    </ul>
    <?php endif; ?>
  </div>

  <div class="card">
    <h2>数据表核对</h2>
    <?php if (count($tables) === 0): ?>
      <p class="dt">尚未读取到表（建表未执行或连接失败）。</p>
    <?php else: ?>
    <table>
      <thead><tr><th style="width:34%">表名</th><th style="width:16%">状态</th><th>当前行数</th></tr></thead>
      <tbody>
        <?php foreach ($tables as $t): ?>
        <tr>
          <td><code><?php echo h($t['name']); ?></code></td>
          <td style="color:<?php echo $t['ok'] ? '#059669' : '#dc2626'; ?>"><?php echo $t['ok'] ? '已建立' : '缺失'; ?></td>
          <td><?php echo $t['count'] === null ? '—' : (int)$t['count']; ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
    <?php endif; ?>

    <div class="kv" style="margin-top:16px">
      连接信息：<b><?php echo h($DB_USER); ?>@<?php echo h($DB_HOST); ?></b> ·
      数据库 <b><?php echo h($DB_NAME); ?></b> ·
      教师账号 <b><?php echo h(SEED_ACCOUNT); ?> / <?php echo h(SEED_PASSWORD); ?></b>
    </div>

    <div class="warn">
      <b>安装完成后请立即删除 install.php。</b>
      保留它等于把「重置教师密码」的入口留在公网上。
    </div>
  </div>

  <div class="card">
    <h2>接下来做这三件事</h2>
    <ol class="next">
      <li>删除服务器上的 <code>install.php</code>（宝塔文件管理里右键删除）。</li>
      <li>打开 <a href="teacher.html" target="_blank">teacher.html</a>，用 <code><?php echo h(SEED_ACCOUNT); ?> / <?php echo h(SEED_PASSWORD); ?></code> 登录，建一个班级。</li>
      <li>打开首页点「开始游玩」→ 应弹出身份窗；填写后玩几步，回教师后台确认能看到轨迹。</li>
    </ol>
  </div>

</div>
</body>
</html>
