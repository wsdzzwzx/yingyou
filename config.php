<?php
/**
 * 安全教育互动影游网络版 — 数据库连接与全局配置
 * 部署位置：项目根目录（与 index.html 同级），密码仅存于服务端
 *
 * 兼容性：PHP 5.5 ~ 8.x 均可运行（未使用 PHP7 专属语法）。
 */

/* ==================== 环境检查 ==================== */
if (version_compare(PHP_VERSION, '5.5.0', '<')) {
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(array('code' => 500, 'msg' => '服务器 PHP 版本过低（' . PHP_VERSION . '），请切换为 PHP 7.4'));
    exit;
}

/* hash_equals 兜底（PHP 5.6 之前没有此函数） */
if (!function_exists('hash_equals')) {
    function hash_equals($known_string, $user_string)
    {
        if (!is_string($known_string) || !is_string($user_string)) {
            return false;
        }
        if (strlen($known_string) !== strlen($user_string)) {
            return false;
        }
        $ret = 0;
        $len = strlen($known_string);
        for ($i = 0; $i < $len; $i++) {
            $ret |= ord($known_string[$i]) ^ ord($user_string[$i]);
        }
        return $ret === 0;
    }
}

/* ==================== 数据库配置（宝塔 anquan 库） ==================== */
define('DB_HOST', '127.0.0.1');
define('DB_NAME', 'anquan');
define('DB_USER', 'anquan');
define('DB_PASS', 'Wstx@123');
define('DB_CHARSET', 'utf8mb4');

/* 教师登录令牌签名密钥（更换后所有教师需重新登录） */
define('AUTH_KEY', 'aq-yingyou-2026-#key');

/* 是否把教师端导出报表包含学生手机号（隐私保护：默认不含，教师端可用开关） */
define('EXPORT_PHONE_DEFAULT', false);

/* ==================== PDO 连接 ==================== */
/* 注意：不要写 function db(): PDO —— PHP 7 才支持返回类型声明，
   PHP 5.6 会报 "unexpected ':', expecting '{'" 导致整站 500。 */
function db()
{
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
        try {
            $pdo = new PDO($dsn, DB_USER, DB_PASS, array(
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ));
        } catch (PDOException $e) {
            json_fail(500, '数据库连接失败');
        }
    }
    return $pdo;
}

/* ==================== 通用输出 ==================== */
/* 必须同时设 Content-Type：PHP 默认是 text/html，
   前端 teacher.html / track.js 会按 content-type 判断是不是 JSON，
   头不对就会被当成「CSV 下载」静默吞掉，表现为点了没反应。 */
function json_ok($data = array())
{
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(array_merge(array('code' => 0), $data), JSON_UNESCAPED_UNICODE);
    exit;
}

function json_fail($httpCode, $msg)
{
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
    }
    http_response_code($httpCode);
    echo json_encode(array('code' => $httpCode, 'msg' => $msg), JSON_UNESCAPED_UNICODE);
    exit;
}

/* ==================== 工具 ==================== */
/**
 * 判断表里是否有某个字段（用于新旧库平滑兼容：
 * 老库的 game_node_trace 没有 node_title / choice_text，代码要能自动降级）
 */
function table_has_column($table, $column)
{
    static $cache = array();
    $key = $table . '.' . $column;
    if (array_key_exists($key, $cache)) {
        return $cache[$key];
    }
    $cache[$key] = false;
    try {
        $st = db()->query('SHOW COLUMNS FROM `' . str_replace('`', '', $table) . '`');
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (isset($row['Field']) && strcasecmp($row['Field'], $column) === 0) {
                $cache[$key] = true;
                break;
            }
        }
    } catch (Exception $e) {
        $cache[$key] = false;
    }
    return $cache[$key];
}

/** 生成随机业务 id（字母前缀 + 16 位 hex） */
function biz_id($prefix)
{
    $hex = '';
    /* random_bytes 是 PHP 7.0+，5.x 下降级到 openssl / mt_rand */
    if (function_exists('random_bytes')) {
        try {
            $hex = bin2hex(random_bytes(8));
        } catch (Exception $e) {
            $hex = '';
        }
    }
    if ($hex === '' && function_exists('openssl_random_pseudo_bytes')) {
        $bytes = openssl_random_pseudo_bytes(8);
        if ($bytes !== false) {
            $hex = bin2hex($bytes);
        }
    }
    if ($hex === '') {
        $hex = substr(md5(uniqid('', true) . mt_rand()), 0, 16);
    }
    return $prefix . $hex;
}

/** 教师登录令牌：按教师 + 日期签名，当日有效 */
function teacher_token($teacherId)
{
    return hash('sha256', $teacherId . '|' . AUTH_KEY . '|' . date('Ymd'));
}

function check_teacher_auth()
{
    $tid  = isset($_SERVER['HTTP_X_TEACHER_ID']) ? trim($_SERVER['HTTP_X_TEACHER_ID']) : '';
    $tok  = isset($_SERVER['HTTP_X_TOKEN']) ? trim($_SERVER['HTTP_X_TOKEN']) : '';
    if ($tid === '' || $tok === '' || !hash_equals(teacher_token($tid), $tok)) {
        json_fail(401, '登录已失效，请重新登录');
    }
    $st = db()->prepare('SELECT teacher_id FROM teachers WHERE teacher_id = ?');
    $st->execute(array($tid));
    if (!$st->fetch()) json_fail(401, '教师账号不存在');
    return $tid;
}

/**
 * 教师是否管理员。
 * 老库可能还没有 is_admin 字段，此时按「最早创建的教师即管理员」兜底，
 * 保证升级过程中始终有人能进教师管理页。
 */
function teacher_is_admin($teacherId)
{
    if (table_has_column('teachers', 'is_admin')) {
        $st = db()->prepare('SELECT is_admin FROM teachers WHERE teacher_id = ?');
        $st->execute(array($teacherId));
        $row = $st->fetch();
        return $row && (int)$row['is_admin'] === 1;
    }
    $st = db()->prepare('SELECT teacher_id FROM teachers ORDER BY create_time ASC, teacher_id ASC LIMIT 1');
    $st->execute();
    $first = $st->fetch();
    return $first && $first['teacher_id'] === $teacherId;
}

/** 要求当前登录者是管理员（新增/删除教师等操作） */
function check_teacher_admin()
{
    $tid = check_teacher_auth();
    if (!teacher_is_admin($tid)) {
        json_fail(403, '只有管理员可以管理教师账号');
    }
    return $tid;
}

/**
 * 校验某条游戏会话是否属于该教师（其学生必须在本教师的某个班级里）。
 * 防止教师 A 拿到教师 B 学生的 record_id 就能看到别人班的数据。
 */
function teacher_owns_record($teacherId, $recordId)
{
    $st = db()->prepare(
        'SELECT 1 FROM game_sessions g
         JOIN class_student_rel r ON r.student_id = g.student_id
         JOIN classes c ON c.class_id = r.class_id
         WHERE g.record_id = ? AND c.teacher_id = ? LIMIT 1'
    );
    $st->execute(array($recordId, $teacherId));
    return (bool)$st->fetch();
}
