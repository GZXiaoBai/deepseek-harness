# Agent Note: 当前引擎原生表示的 JSON 原型校验

Status: implemented

[English](2026-09-05-engine-native-json-prototype-validation.md) | 中文

## Problem

WebKit 在内建构造函数的 `[native code]` 两侧输出换行，而 V8 输出空格。将构造函数与 V8 字符串字面量比较的 JSON 校验器会拒绝普通 WebKit 对象。随后，助手消息流回放中断对话订阅，即使后端提供有效历史，聊天正文仍为空。

## Decision

`hasIntrinsicConstructor` 将候选函数的原生源码与当前引擎的 `Object` 或 `Array` 构造函数比较。构造函数名称、原型身份和原型继承链检查仍为必需。[历史 Session 迁移](../architecture/2026-08-31-released-session-format-migrations.zh.md)与浏览器回放由此采用相同的无损 JSON 规则，不假定 V8 格式。

## Alternatives considered

**接受所有名称相符的构造函数。** 不采用，因为用户定义的构造函数可以伪造名称与原型关联。

**跳过浏览器回放中的 JSON 校验。** 不采用，因为消息流由进程外传输解码而来，仍需要结构校验。

## Consequences

跨 realm 的普通容器仍被接受，伪造原型仍被拒绝。单元测试覆盖多行原生表示和伪造原型；真实 WebKit 历史回放检查完整浏览器路径。校验器假定引擎内建函数可信。
