# 分镜大师项目规格说明书 (SPEC)

## 1. 项目概述

### 1.1 项目目标
将现有"分镜助手"程序升级为"分镜大师"，并集成小鸭中台（原小鸭中台）用户系统，实现用户认证、次数管理、API密钥同步、支付充值等功能。

### 1.2 技术栈
- 前端: React + TypeScript + Zustand + @xyflow/react + TailwindCSS
- 后端: Tauri 2 + Rust (命令式接口) + SQLite (rusqlite, WAL)
- 服务器: 小鸭中台 (FastAPI + Uvicorn + Nginx反向代理)
- 认证: 设备令牌认证 (X-Device-Token头)

### 1.3 核心原则
- 解耦、可扩展、可回归验证
- 自动持久化、交互性能优先
- 严格遵守"只能修改明确指出的代码"原则

## 2. 功能需求

### 2.1 用户认证系统
- **登录/注册**: 支持用户名/密码登录和注册，连接服务器 47.108.237.10
- **设备令牌**: 登录成功后获取设备令牌，保存到本地存储 (Tauri应用数据目录)
- **状态保持**: 登录状态长久保持，用户可在设置页面手动退出
- **多用户支持**: 支持同一设备多个用户登录

### 2.2 用户次数管理
- **查询时机**: 每次登录时查询剩余次数
- **扣费规则**: 生成一张图片扣除1次
- **余额显示**: 在程序设置页面建立"我的"页面，显示剩余次数、用户名等信息
- **0次处理**: 
  - 允许查看但不能生成图片
  - 用户点击生成时，导航到设置页面的"我的"标签页进行充值
  - 显示专业提示信息："您的剩余次数为0，请充值后继续使用！费用包含分镜大师和claude分镜模型的总和费用!"

### 2.3 API密钥同步机制
- **同步范围**: 同步所有类型的API密钥（包括KIE、FAL、PPIO、GRSAI等）
- **更新时机**: 登录时同步、启动时自动同步
- **本地存储**: 存储在Tauri应用数据目录
- **加密存储**: 密钥需要加密存储
- **清除机制**: 退出登录时清除本地存储的API密钥

### 2.4 充值流程设计
- **触发条件**: 系统检测到0次时自动导航到充值页面
- **支付方式**: 支持支付宝、微信支付
- **支付确认**: 通过服务器回调通知确认支付成功
- **次数刷新**: 支付成功后根据服务器端定价配置页面的定价配置，根据充值金额刷新次数
- **状态查询**: 可查询支付订单状态

### 2.5 程序重命名
- **配置文件**: `tauri.conf.json` 中的 `productName` 从"分镜助手"改为"分镜大师"
- **界面文本**: 所有界面中出现的"分镜助手"改为"分镜大师"
- **安装程序**: 安装程序名从 `stroy-fenjing`、`fenjingstory` 相应调整
- **系统菜单**: 显示为"分镜大师v1.02"

## 3. 服务器端需求

### 3.1 小鸭中台架构
- **技术栈**: FastAPI + SQLAlchemy + SQLite
- **管理后台**: Streamlit Web界面
- **客户端**: 分镜大师 (Windows EXE程序)
- **数据库**: SQLite (可升级到MySQL/PostgreSQL)
- **支付SDK**: 支付宝/微信支付官方SDK

### 3.2 核心功能
1. **多模型生图API管理** - 支持阿里云、豆包等多种生图API，后台配置管理
2. **设备令牌鉴权** - 为分镜大师提供长期有效的设备令牌
3. **自定义定价策略** - 后台可配置金额-次数对应关系（如899元=50次）
4. **第三方支付集成** - 支付宝、微信支付集成
5. **EXE强制充值弹窗** - 次数用尽后强制显示内嵌浏览器充值页面
6. **Claude skill技能验证** - 验证用户账户状态，控制skill访问权限
7. **Streamlit管理后台** - 完整的后台管理系统

### 3.3 API接口

#### 3.3.1 用户认证接口
- `POST /api/v1/auth/register` - 用户注册
- `POST /api/v1/auth/login` - 用户登录
- `GET /api/v1/auth/me` - 获取当前用户信息

#### 3.3.2 订阅及次数管理接口
- `GET /api/v1/subscriptions` - 获取用户订阅信息
- `GET /api/v1/api-calls/user-credits` - 查询用户剩余次数
- `POST /api/v1/api-calls/consume-credit` - 消耗用户次数（关键扣费接口）
- `GET /api/v1/api-calls/dashboard-stats` - 获取仪表板统计数据

#### 3.3.3 支付管理接口
- `POST /api/v1/payments/create` - 创建支付订单
- `GET /api/v1/payments/{order_id}/query` - 查询支付状态
- `GET /api/v1/pricing` - 获取定价配置列表

#### 3.3.4 API配置接口
- `GET /api/v1/api-configs/active` - 获取活动API配置
- `POST /api/v1/api-calls/` - 调用图像生成API（包含计费逻辑）

### 3.4 技能文件管理

#### 3.4.1 功能概述
- **菜单名称**: 技能更新（Streamlit管理后台）
- **功能描述**: 允许管理员上传一个skill.md文件，该文件用于Claude技能更新
- **存储位置**: 服务器 `/jy/data/skill/skill.md` 目录，仅保留最新文件（新文件覆盖旧文件）

#### 3.4.2 API接口
- `POST /api/v1/skill/file` - 上传skill.md文件（支持.md格式）
- `GET /api/v1/skill/file` - 获取skill.md文件内容（公开访问）

#### 3.4.3 访问参数
- **文件存储路径**: `/jy/data/skill/skill.md`
- **HTTP端点**: `http://47.108.237.10:3003/api/v1/skill/file`
- **认证方式**: 上传需要管理员Bearer token，获取内容公开访问
- **文件限制**: 仅支持.md格式，自动覆盖旧文件

#### 3.4.4 后续扩展
- 可用于Claude skill自动更新功能
- 支持版本管理、历史记录、多语言技能文件等

### 3.5 服务器代码修改流程
- **修改权限**: 需要修改服务器代码时有权限
- **同步机制**: 修改后直接同步到本地 `jiaoyan` 目录
- **备份策略**: 修改前需要备份原有代码
- **测试环境**: 直接修改生产服务器

## 4. 数据模型

### 4.1 前端数据模型
```typescript
// 用户信息
interface BananaUserInfo {
  user_id: number;
  username: string;
  email: string;
  is_active: boolean;
  is_account_active: boolean;
  credits: number;          // 剩余次数
  total_credits: number;    // 总次数
  used_credits: number;     // 已用次数
}

// 支付订单
interface PaymentOrder {
  order_id: string;
  payment_url: string;
  qr_code?: string;
  amount: number;
  credits: number;
}

// API配置
interface ApiConfig {
  id: number;
  api_name: string;
  api_type: string;
  api_url: string;
  api_key: string;          // 需要同步的API密钥
  is_active: boolean;
  // ... 其他字段
}

// 信用信息
interface BananaCreditsInfo {
  credits: number;          // 剩余次数
}

// 生成错误报告
interface GenerationDebugContext {
  sourceType: string;        // 'imageEdit' | 'storyboardGen'
  providerId: string;        // 'ppio' | 'grsai' | 'volcengine'
  requestModel: string;      // 具体模型ID
  requestSize: string;       // 请求的尺寸
  requestAspectRatio: string; // 请求的比例
  prompt: string;            // 生成提示词
  extraParams: Record<string, unknown>; // 额外参数
  referenceImageCount: number; // 参考图片数量
  referenceImagePlaceholders: string[]; // 参考图片占位符
  appVersion: string;        // 应用版本
  osName: string;           // 操作系统名称
  osVersion: string;        // 操作系统版本
  osBuild: string;          // 操作系统构建号
  userAgent: string;        // 用户代理字符串
}
```

### 4.2 服务器数据模型（小鸭中台）
```python
# User - 用户表
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True)  # 账户激活状态
    is_account_active = Column(Boolean, default=True)  # 用于控制skill访问
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# ApiConfig - API配置表
class ApiConfig(Base):
    __tablename__ = "api_configs"
    id = Column(Integer, primary_key=True, index=True)
    api_name = Column(String(100), nullable=False)  # 如"阿里云生图API"
    api_type = Column(String(50), nullable=False)  # 扩展枚举：ALIYUN_IMAGE, DOUBAO_IMAGE等
    api_url = Column(String(500), nullable=False)  # API端点URL
    api_key = Column(Text)  # API密钥
    is_active = Column(Boolean, default=False)  # 是否使能（单选）
    supports_image_generation = Column(Boolean, default=False)
    supports_reference_image = Column(Boolean, default=False)
    default_image_width = Column(Integer, default=1024)
    default_image_height = Column(Integer, default=1024)
    max_image_size = Column(Integer, default=2048)
    image_quality = Column(String(20), default="high")
    additional_params = Column(Text)  # JSON格式的额外参数
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# UserToken - 用户令牌表
class UserToken(Base):
    __tablename__ = "user_tokens"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    device_token = Column(String(255), unique=True, index=True, nullable=False)
    device_info = Column(String(255))  # 设备信息
    expires_at = Column(DateTime)  # 过期时间（可为空，表示长期有效）
    created_at = Column(DateTime, default=datetime.utcnow)
    last_used_at = Column(DateTime)

# Subscription - 订阅/次数管理表
class Subscription(Base):
    __tablename__ = "subscriptions"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    total_credits = Column(Integer, default=0)  # 总次数
    used_credits = Column(Integer, default=0)   # 已使用次数
    remaining_credits = Column(Integer, default=0)  # 剩余次数
    is_active = Column(Boolean, default=True)   # 订阅是否激活
    expires_at = Column(DateTime)               # 过期时间
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# PricingConfig - 定价配置表
class PricingConfig(Base):
    __tablename__ = "pricing_configs"
    id = Column(Integer, primary_key=True, index=True)
    amount = Column(Numeric(10, 2), nullable=False)  # 金额，如899.00
    credits = Column(Integer, nullable=False)        # 对应次数，如50
    description = Column(String(255))                # 描述，如"50张图套餐"
    is_active = Column(Boolean, default=True)       # 是否启用
    sort_order = Column(Integer, default=0)         # 排序
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# Payment - 支付订单表
class Payment(Base):
    __tablename__ = "payments"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    order_id = Column(String(100), unique=True, nullable=False)  # 商户订单号
    payment_id = Column(String(100))  # 支付平台订单号
    amount = Column(Numeric(10, 2), nullable=False)
    credits = Column(Integer, nullable=False)  # 购买次数
    payment_method = Column(String(50), nullable=False)  # alipay, wechat
    status = Column(String(20), default="pending")  # pending, paid, failed, refunded
    paid_at = Column(DateTime)  # 支付成功时间
    created_at = Column(DateTime, default=datetime.utc

## 5. 版本历史

### v0.1.14 (2026-04-23)

#### 新增
- Claude CLI settings.json 自动同步 — 登录和启动时将 device_token 同步到 `settings.json` 和 seedance-t `auth_cache.json`
- seedance-t `check_credits.py` 自动拉起分镜大师 — 检查剩余次数前确保分镜大师在运行
- PaymentDialog 管理页面按钮 — 点击跳转到 `http://aixiaoxi.top/jy/api-portal/`
- macOS bundle 构建配置

#### 优化
- 清除 Rust 编译警告（未使用函数、import、重复 match 分支）
- 清除 TypeScript 编译错误（未使用变量、import）
- PaymentDialog 改用 `openUrl` 替代 `window.open`（Tauri webview 兼容）
- 版本升级脚本和 GitHub Actions 构建工作流

#### 构建
- Windows: NSIS 安装包
- macOS: 通用 DMG
